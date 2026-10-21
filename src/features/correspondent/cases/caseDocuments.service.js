'use strict';

const { Op } = require('sequelize');
const { FinancingCase, CaseRequirement, CaseDocument, File } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishFinancingDocumentsCompleted, publishFinancingStatusChanged } = require('../correspondentEvents.service');
const { shouldApplyTransition } = require('../statusMachine');

const INCOMPLETE_REQUIREMENT_STATUSES = ['PENDING', 'REJECTED', 'EXPIRED'];
const CHECKLIST_COMPLETO = 'VALIDATED';

const DOCUMENT_TYPES = ['RG_CPF', 'COMPROVANTE_RENDA', 'COMPROVANTE_RESIDENCIA', 'MATRICULA_IMOVEL', 'CERTIDAO_ESTADO_CIVIL', 'IPTU', 'OUTRO'];

// Tipos que normalmente chegam como documento escaneado/gerado (PDF) — uma foto solta costuma
// significar que a pessoa fotografou a tela em vez de anexar o PDF oficial. Não é OCR/IA: é uma
// heurística determinística e declarada como tal, só pra dar um alerta ao validador humano, que
// segue sendo quem decide (status VALIDATED sempre exige ação humana).
const DOCUMENT_TYPES_EXPECTING_PDF = ['COMPROVANTE_RENDA', 'MATRICULA_IMOVEL', 'CERTIDAO_ESTADO_CIVIL', 'IPTU'];

/**
 * buildSuggestedNote — sugestão heurística determinística (substituto honesto do "OCR/IA" do
 * Caderno, que é fronteira explícita com o Marco 9/NAY generativa — fora de escopo aqui). Nunca
 * bloqueia nada, só anota um alerta pro validador humano conferir com mais atenção.
 */
function buildSuggestedNote(documentType, file) {
  const notes = [];
  if (DOCUMENT_TYPES_EXPECTING_PDF.includes(documentType) && file.mimeType && file.mimeType.startsWith('image/')) {
    notes.push('Arquivo enviado como imagem/foto, mas este tipo de documento normalmente é um PDF oficial — confirme se está legível e completo antes de validar.');
  }
  if (file.sizeBytes && file.sizeBytes < 10 * 1024) {
    notes.push('Arquivo muito pequeno (menos de 10KB) — pode estar incompleto ou ilegível.');
  }
  return notes.length ? notes.join(' ') : null;
}

async function getCaseOrThrow(financingCaseId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  return financingCase;
}

/**
 * createRequirement — adiciona um item ao checklist de documentos exigidos do caso.
 */
async function createRequirement(financingCaseId, payload, actorUserId, actorContext, transaction) {
  const { groupId, companyId } = actorContext;
  await getCaseOrThrow(financingCaseId, groupId, companyId, transaction);

  const { documentType, required, notes } = payload || {};
  if (!documentType || !DOCUMENT_TYPES.includes(documentType)) {
    throw AppError.badRequest(`"documentType" precisa ser um de: ${DOCUMENT_TYPES.join(', ')}.`, 'CASE_REQUIREMENT_VALIDATION');
  }

  const requirement = await CaseRequirement.create(
    {
      groupId,
      companyId,
      financingCaseId,
      documentType,
      required: required !== false,
      status: 'PENDING',
      notes: notes || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.case_requirement.created',
      entityType: 'CaseRequirement',
      entityId: requirement.id,
      beforeJson: { registro: 'Não existia (registro criado nesta ação)' },
      afterJson: { id: requirement.id, documentType: requirement.documentType, status: requirement.status },
      reason: `Requirement "${documentType}" adicionado ao caso de financiamento.`,
    },
    transaction
  );

  await syncCaseChecklistStatus(financingCaseId, groupId, companyId, actorUserId, transaction);
  return requirement;
}

/**
 * listRequirements — `canSeeDocuments` reflete se o ator tem a permissão dedicada
 * `correspondent:documents:read`. Sem ela, o checklist (status/tipo) ainda é visível — útil
 * pra acompanhar o andamento do caso — mas o array `documents` (referência ao arquivo RESTRICTED
 * em si) vem vazio, nunca com `fileId`/metadado do arquivo. Fail closed: por padrão (chamador
 * não informa `canSeeDocuments`), documentos ficam ocultos.
 */
async function listRequirements(financingCaseId, actorContext, transaction, { canSeeDocuments = false } = {}) {
  const { groupId, companyId } = actorContext;
  await getCaseOrThrow(financingCaseId, groupId, companyId, transaction);
  const requirements = await CaseRequirement.findAll({
    where: { financingCaseId, groupId, companyId },
    include: canSeeDocuments
      ? [{ model: CaseDocument, as: 'documents', where: { supersededAt: null }, required: false, include: [{ model: File, as: 'file', attributes: ['id', 'fileName', 'mimeType', 'sizeBytes'] }] }]
      : [],
    order: [['created_at', 'ASC']],
    transaction,
  });
  if (!canSeeDocuments) {
    return requirements.map((r) => {
      const plain = r.get({ plain: true });
      plain.documents = [];
      return plain;
    });
  }
  return requirements;
}

/**
 * uploadDocument — registra uma nova VERSÃO de documento pro requirement. Nunca sobrescreve: se
 * já existe uma versão vigente (supersededAt IS NULL), ela é marcada como superada e uma nova
 * linha é criada com version+1 — histórico completo preservado (Caderno: "Documento substituído
 * preserva versão anterior").
 */
async function uploadDocument(financingCaseId, requirementId, payload, actorUserId, actorContext, transaction) {
  const { groupId, companyId } = actorContext;
  await getCaseOrThrow(financingCaseId, groupId, companyId, transaction);

  if (!requirementId) {
    throw AppError.badRequest('"requirementId" é obrigatório — informe a qual item do checklist este documento pertence.', 'CASE_DOCUMENT_VALIDATION');
  }
  const requirement = await CaseRequirement.findOne({ where: { id: requirementId, financingCaseId, groupId, companyId }, transaction });
  if (!requirement) {
    throw AppError.notFound('Item de checklist (requirement) não encontrado para este caso.', 'CASE_REQUIREMENT_NOT_FOUND');
  }

  const { fileId, expiresAt } = payload || {};
  if (!fileId) {
    throw AppError.badRequest('"fileId" é obrigatório — envie o arquivo em "/files" primeiro e use o id retornado.', 'CASE_DOCUMENT_VALIDATION');
  }
  const file = await File.findOne({ where: { id: fileId, groupId, companyId }, transaction });
  if (!file) {
    throw AppError.badRequest('Arquivo não encontrado nesta empresa — envie em "/files" antes de anexar.', 'CASE_DOCUMENT_FILE_NOT_FOUND');
  }

  const current = await CaseDocument.findOne({ where: { requirementId, supersededAt: null }, transaction });
  const nextVersion = current ? current.version + 1 : 1;

  if (current) {
    current.supersededAt = new Date();
    await current.save({ transaction });
  }

  // Sinaliza (nunca bloqueia) re-upload do MESMO conteúdo exato pro mesmo requirement — hash já
  // calculado por files.service.js#uploadFile (checksumSha256), reusado aqui sem duplicar lógica.
  let duplicateOfDocumentId = null;
  if (file.checksumSha256) {
    const previousVersions = await CaseDocument.findAll({
      where: { requirementId },
      include: [{ model: File, as: 'file', attributes: ['checksumSha256'], where: { checksumSha256: file.checksumSha256 } }],
      transaction,
    });
    if (previousVersions.length > 0) {
      duplicateOfDocumentId = previousVersions[0].id;
    }
  }

  const document = await CaseDocument.create(
    {
      groupId,
      companyId,
      financingCaseId,
      requirementId,
      fileId,
      version: nextVersion,
      classification: 'RESTRICTED',
      expiresAt: expiresAt || null,
      uploadedBy: actorUserId || null,
      duplicateOfDocumentId,
      suggestedNote: buildSuggestedNote(requirement.documentType, file),
    },
    { transaction }
  );

  requirement.status = 'SUBMITTED';
  requirement.updatedBy = actorUserId || null;
  await requirement.save({ transaction });

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.case_document.uploaded',
      entityType: 'CaseDocument',
      entityId: document.id,
      beforeJson: current
        ? { documentId: current.id, version: current.version, superseded: true }
        : { registro: 'Não existia (registro criado nesta ação)' },
      afterJson: { id: document.id, version: document.version, classification: document.classification, requirementStatus: requirement.status },
      reason: `Documento RESTRICTED enviado (versão ${nextVersion}) para o requirement "${requirement.documentType}".` +
        (current ? ' Versão anterior preservada como superada.' : ''),
    },
    transaction
  );

  await syncCaseChecklistStatus(financingCaseId, groupId, companyId, actorUserId, transaction);
  return document;
}

/**
 * validateRequirement — a validação humana do pipeline
 * "Upload → malware scan → hash → OCR/IA → sugestão → validação".
 * Só um ator humano valida um documento já enviado. A NAY não chama esta função.
 */
async function validateRequirement(financingCaseId, requirementId, actorUserId, actorContext, transaction) {
  const { groupId, companyId } = actorContext;
  await getCaseOrThrow(financingCaseId, groupId, companyId, transaction);
  if (!actorUserId) {
    throw AppError.unprocessable('A validação do documento exige uma pessoa.', 'CASE_REQUIREMENT_VALIDATION_ACTOR_REQUIRED');
  }
  const requirement = await CaseRequirement.findOne({ where: { id: requirementId, financingCaseId, groupId, companyId }, transaction });
  if (!requirement) {
    throw AppError.notFound('Item de checklist (requirement) não encontrado para este caso.', 'CASE_REQUIREMENT_NOT_FOUND');
  }
  if (requirement.status !== 'SUBMITTED') {
    throw AppError.unprocessable(
      'Só um documento já enviado pode ser validado.',
      'CASE_REQUIREMENT_NOT_READY_TO_VALIDATE'
    );
  }

  const beforeStatus = requirement.status;
  requirement.status = CHECKLIST_COMPLETO;
  requirement.updatedBy = actorUserId;
  await requirement.save({ transaction });

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.case_requirement.validated',
      entityType: 'CaseRequirement',
      entityId: requirement.id,
      beforeJson: { status: beforeStatus },
      afterJson: { status: requirement.status, documentType: requirement.documentType },
      reason: `Requirement "${requirement.documentType}" validado por pessoa.`,
    },
    transaction
  );

  await syncCaseChecklistStatus(financingCaseId, groupId, companyId, actorUserId, transaction);
  await publishDocumentsCompletedIfReady(financingCaseId, groupId, companyId, transaction);
  return requirement;
}

async function publishDocumentsCompletedIfReady(financingCaseId, groupId, companyId, transaction) {
  const totalRequired = await CaseRequirement.count({ where: { financingCaseId, groupId, companyId, required: true }, transaction });
  const pendingRequired = await CaseRequirement.count({
    where: { financingCaseId, groupId, companyId, required: true, status: { [Op.ne]: CHECKLIST_COMPLETO } },
    transaction,
  });
  if (totalRequired > 0 && pendingRequired === 0) {
    const financingCase = await getCaseOrThrow(financingCaseId, groupId, companyId, transaction);
    await publishFinancingDocumentsCompleted(financingCase, transaction);
  }
}

async function syncCaseChecklistStatus(financingCaseId, groupId, companyId, actorUserId, transaction) {
  const financingCase = await getCaseOrThrow(financingCaseId, groupId, companyId, transaction);
  const required = await CaseRequirement.findAll({
    where: { financingCaseId, groupId, companyId, required: true },
    transaction,
  });
  if (required.length === 0) return financingCase;

  const allValidated = required.every((item) => item.status === CHECKLIST_COMPLETO);
  const target = allValidated ? 'READY_TO_SUBMIT' : 'DOCUMENTS_PENDING';
  if (financingCase.status === target || !shouldApplyTransition(financingCase.status, target)) return financingCase;

  const beforeStatus = financingCase.status;
  financingCase.status = target;
  financingCase.updatedBy = actorUserId || null;
  await financingCase.save({ transaction });

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.financing_case.status_changed',
      entityType: 'FinancingCase',
      entityId: financingCase.id,
      beforeJson: { status: beforeStatus },
      afterJson: { status: target },
      reason: allValidated
        ? 'Checklist validado. Caso pronto para envio.'
        : 'Checklist de documentos aberto.',
    },
    transaction
  );
  await publishFinancingStatusChanged(
    financingCase,
    { previousStatus: beforeStatus, normalizedStatus: target, historyId: `checklist:${financingCase.id}:${target}` },
    transaction
  );
  return financingCase;
}

module.exports = {
  DOCUMENT_TYPES,
  INCOMPLETE_REQUIREMENT_STATUSES,
  createRequirement,
  listRequirements,
  uploadDocument,
  validateRequirement,
  syncCaseChecklistStatus,
};
