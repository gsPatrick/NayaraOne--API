'use strict';

const { FinancingCase, CaseRequirement, CaseDocument, File } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');

const DOCUMENT_TYPES = ['RG_CPF', 'COMPROVANTE_RENDA', 'COMPROVANTE_RESIDENCIA', 'MATRICULA_IMOVEL', 'CERTIDAO_ESTADO_CIVIL', 'IPTU', 'OUTRO'];

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
      reason: `Requirement "${documentType}" adicionado ao caso de financiamento.`,
    },
    transaction
  );

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

  const { fileId } = payload || {};
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

  const document = await CaseDocument.create(
    {
      groupId,
      companyId,
      financingCaseId,
      requirementId,
      fileId,
      version: nextVersion,
      classification: 'RESTRICTED',
      uploadedBy: actorUserId || null,
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
      reason: `Documento RESTRICTED enviado (versão ${nextVersion}) para o requirement "${requirement.documentType}".` +
        (current ? ' Versão anterior preservada como superada.' : ''),
    },
    transaction
  );

  return document;
}

module.exports = { DOCUMENT_TYPES, createRequirement, listRequirements, uploadDocument };
