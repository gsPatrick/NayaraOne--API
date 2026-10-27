'use strict';

const crypto = require('crypto');

const { Op } = require('sequelize');
const { sequelize, FinancingCase, CaseRequirement, CaseDocument, CaseApplicant, File, Task } = require('../../../models');
const { isValidTaxIdDigits } = require('../../people/personDocumentFormat.service');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishFinancingDocumentsCompleted, publishFinancingStatusChanged } = require('../correspondentEvents.service');
const { shouldApplyTransition, assertCaseNotCanceled } = require('../statusMachine');
const { assertCaseAcceptsAction } = require('./caseActionGate');
const { getFileContent, matchesDeclaredType } = require('../../files/files.service');
const { resolveOcrAdapter } = require('../../people/adapters/resolveDocumentAdapters');
const { LocalOcrAdapter } = require('../../people/adapters/LocalOcrAdapter');

const INCOMPLETE_REQUIREMENT_STATUSES = ['PENDING', 'REJECTED', 'EXPIRED'];
const CHECKLIST_COMPLETO = 'VALIDATED';
// Itens que não contam para o checklist: vencido (já substituído por um novo) e dispensado (por uma pessoa, com motivo).
const NOT_COUNTED_STATUSES = ['EXPIRED', 'DISPENSED'];
const OPEN_REQUIREMENT_STATUSES = ['PENDING', 'SUBMITTED', 'REJECTED'];
const DOCUMENT_TYPE_LABEL = {
  RG_CPF: 'RG/CPF', COMPROVANTE_RENDA: 'comprovante de renda', COMPROVANTE_RESIDENCIA: 'comprovante de residência',
  MATRICULA_IMOVEL: 'matrícula do imóvel', CERTIDAO_ESTADO_CIVIL: 'certidão de estado civil', IPTU: 'IPTU',
  EXTRATO_BANCARIO: 'extrato bancário', OUTRO: 'outro documento',
};
const docLabel = (type) => DOCUMENT_TYPE_LABEL[type] || type;
const REQUIREMENT_NOTES_MAX = 500;
// Documentos que pertencem a cada proponente (os de imóvel são do caso). Com mais de um proponente, o checklist
// mínimo da empresa vale para cada um deles.
const PERSONAL_DOCUMENT_TYPES = ['RG_CPF', 'COMPROVANTE_RENDA', 'COMPROVANTE_RESIDENCIA', 'CERTIDAO_ESTADO_CIVIL', 'EXTRATO_BANCARIO'];

/** O tipo declarado do arquivo precisa bater com o conteúdo (arquivo em disco). Fixtures sem binário seguem. */
async function assertContentMatchesDeclaredType(file, actorUserId, transaction) {
  let withContent;
  try {
    withContent = await getFileContent(file.id, transaction, actorUserId, file);
  } catch (err) {
    if (err instanceof AppError && err.code === 'FILE_CONTENT_NOT_FOUND') return;
    throw err;
  }
  if (!matchesDeclaredType(withContent.getDataValue('content'), file.mimeType)) {
    throw AppError.badRequest('O conteúdo do arquivo não corresponde ao tipo informado. Envie o arquivo original sem renomear a extensão.', 'CASE_DOCUMENT_TYPE_MISMATCH');
  }
}

/** Data de validade estrita (AAAA-MM-DD, calendário real, hoje ou futura) ou data/hora ISO futura. */
function parseExpiresAt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw AppError.badRequest('A data de validade do documento é inválida.', 'CASE_DOCUMENT_VALIDATION');
  }
  let date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const check = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== value) {
      throw AppError.badRequest('A data de validade do documento é inválida.', 'CASE_DOCUMENT_VALIDATION');
    }
    date = new Date(`${value}T23:59:59-03:00`);
  } else {
    date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw AppError.badRequest('A data de validade do documento é inválida.', 'CASE_DOCUMENT_VALIDATION');
    }
  }
  if (date.getTime() < Date.now()) {
    throw AppError.badRequest('A data de validade do documento já passou: envie um documento dentro da validade.', 'CASE_DOCUMENT_EXPIRED_ON_UPLOAD');
  }
  return date;
}

/** Trava o caso para as operações que movem o checklist (validação, envio, recusa, dispensa). */
async function lockCase(financingCaseId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!financingCase) throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  return financingCase;
}

const DOCUMENT_TYPES = ['RG_CPF', 'COMPROVANTE_RENDA', 'COMPROVANTE_RESIDENCIA', 'MATRICULA_IMOVEL', 'CERTIDAO_ESTADO_CIVIL', 'IPTU', 'EXTRATO_BANCARIO', 'OUTRO'];

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
  // PDF com texto pode ser pequeno de verdade; o alerta de tamanho vale para foto/imagem e outros formatos.
  if (file.sizeBytes && file.sizeBytes < 10 * 1024 && file.mimeType !== 'application/pdf') {
    notes.push('Arquivo muito pequeno (menos de 10KB): pode estar incompleto ou ilegível.');
  }
  return notes.length ? notes.join(' ') : null;
}

const READING_FIELD_LABELS = { name: 'Nome', taxId: 'CPF/CNPJ', income: 'Renda', accountNumber: 'Conta', issuedAt: 'Emissão', expiresAt: 'Validade' };
// Campos que a leitura precisa encontrar para o documento poder ser validado. O caderno diz que
// "documento ilegível gera pendência, não dado inventado" e que a validação é humana, mas não lista
// os campos por tipo; esta é a lista mínima de cada tipo. Tipos que não aparecem aqui (matrícula,
// IPTU, outro) só exigem que o documento seja legível.
const CRITICAL_FIELDS_BY_DOCUMENT_TYPE = {
  RG_CPF: ['taxId', 'name'],
  COMPROVANTE_RENDA: ['income'],
  EXTRATO_BANCARIO: ['accountNumber'],
};
const READING_ENGINE_LABELS = { pdftotext: 'texto do PDF', tesseract: 'reconhecimento de imagem (OCR)' };

function formatReadingValue(key, value) {
  if (key === 'taxId') {
    const d = String(value).replace(/\D/g, '');
    if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  }
  if (key === 'income') return `R$ ${Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (key === 'issuedAt' || key === 'expiresAt') return String(value).replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3/$2/$1');
  return String(value);
}

/**
 * readDocumentAutomatically — passo "OCR/IA → sugestão" do pipeline. Só roda quando o leitor real
 * está ativado (OCR_PROVIDER=local); com o adaptador de laboratório devolve null e o fluxo segue
 * como antes. Nunca valida nada: o resultado é só texto de apoio para quem valida.
 */
async function readDocumentAutomatically(documentType, file, actorUserId, transaction) {
  const adapter = await resolveOcrAdapter({ groupId: file.groupId, companyId: file.companyId }, transaction);
  if (!(adapter instanceof LocalOcrAdapter)) return null;
  try {
    const withContent = await getFileContent(file.id, transaction, actorUserId, file);
    const extraction = await adapter.extract(withContent.getDataValue('content'), documentType);
    if (extraction.illegible) {
      return {
        illegible: true,
        status: 'ILLEGIBLE',
        foundFields: [],
        note: 'Leitura automática: o documento está ilegível ou sem texto reconhecível, e nenhum dado foi extraído. Peça um novo arquivo antes de validar.',
      };
    }
    const percent = Math.round((extraction.confidence || 0) * 100);
    const origin = READING_ENGINE_LABELS[extraction.raw?.engine] || 'leitura automática';
    const found = Object.entries(extraction.fields || {}).map(([key, value]) => `${READING_FIELD_LABELS[key] || key}: ${formatReadingValue(key, value)}`);
    return {
      illegible: false,
      status: 'READ',
      foundFields: Object.keys(extraction.fields || {}),
      note: found.length
        ? `Leitura automática (${origin}, confiança de ${percent}%): ${found.join('; ')}. Confira com o arquivo original antes de validar.`
        : `Leitura automática (${origin}, confiança de ${percent}%): nenhum campo conhecido foi encontrado no texto. Confira o arquivo original antes de validar.`,
    };
  } catch (err) {
    // Arquivo adulterado nunca entra no caso: o bloqueio de integridade sobe como erro.
    if (err instanceof AppError && err.code === 'FILE_INTEGRITY_VIOLATION') throw err;
    // eslint-disable-next-line no-console
    console.error(`[CaseDocuments] Leitura automática falhou para o arquivo ${file.id}: ${String(err && err.message).slice(0, 200)}`);
    return { illegible: false, status: 'NOT_READ', foundFields: [], note: 'Leitura automática indisponível neste momento. Confira o documento manualmente antes de validar.' };
  }
}

async function getCaseOrThrow(financingCaseId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  return financingCase;
}

/**
 * createRequirement — adiciona um item ao checklist de documentos exigidos do caso. Um tipo de documento
 * só pode ter um item em aberto por caso (exceto "outro documento"): duplo clique ou tipo repetido não
 * cria item igual.
 */
async function createRequirement(financingCaseId, payload, actorUserId, actorContext, transaction) {
  const { groupId, companyId } = actorContext;
  const financingCase = await lockCase(financingCaseId, groupId, companyId, transaction);
  await assertCaseAcceptsAction(financingCase, 'requirement', transaction);

  const { documentType, required, notes, applicantId } = payload || {};
  if (!documentType || !DOCUMENT_TYPES.includes(documentType)) {
    throw AppError.badRequest(`O tipo do documento precisa ser um destes: ${DOCUMENT_TYPES.map(docLabel).join(', ')}.`, 'CASE_REQUIREMENT_VALIDATION');
  }
  if (required !== undefined && typeof required !== 'boolean') {
    throw AppError.badRequest('O campo "obrigatório" precisa ser verdadeiro ou falso.', 'CASE_REQUIREMENT_VALIDATION');
  }
  if (notes !== undefined && notes !== null && (typeof notes !== 'string' || notes.length > REQUIREMENT_NOTES_MAX)) {
    throw AppError.badRequest(`A observação do item deve ser um texto de até ${REQUIREMENT_NOTES_MAX} caracteres.`, 'CASE_REQUIREMENT_VALIDATION');
  }
  if (applicantId !== undefined && applicantId !== null) {
    const applicant = typeof applicantId === 'string' ? await CaseApplicant.findOne({ where: { id: applicantId, financingCaseId, groupId, companyId }, transaction }).catch(() => null) : null;
    if (!applicant) {
      throw AppError.badRequest('O proponente informado não faz parte deste caso.', 'CASE_REQUIREMENT_VALIDATION');
    }
  }
  if (documentType !== 'OUTRO') {
    const duplicate = await CaseRequirement.findOne({ where: { financingCaseId, groupId, companyId, documentType, applicantId: applicantId || null, status: OPEN_REQUIREMENT_STATUSES }, transaction });
    if (duplicate) {
      throw AppError.conflict(`O checklist já tem um item em aberto para "${docLabel(documentType)}". Use o item existente.`, 'CASE_REQUIREMENT_DUPLICATE');
    }
  }

  const requirement = await CaseRequirement.create(
    {
      groupId,
      companyId,
      financingCaseId,
      documentType,
      applicantId: applicantId || null,
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
      reason: `Item "${docLabel(documentType)}" adicionado ao checklist do caso de financiamento.`,
    },
    transaction
  );

  await syncCaseChecklistStatus(financingCaseId, groupId, companyId, actorUserId, transaction);
  return requirement;
}

/**
 * dismissRequirement — dispensa um item do checklist (cadastrado por engano, duplicado ou que o banco não pede).
 * Nada é apagado: o item fica DISPENSADO com quem, quando e o motivo, e deixa de contar para o checklist.
 * Item já validado não é dispensado (recuse antes, se estava errado).
 */
async function dismissRequirement(financingCaseId, requirementId, reasonText, actorUserId, actorContext, transaction) {
  const { groupId, companyId } = actorContext;
  const financingCase = await lockCase(financingCaseId, groupId, companyId, transaction);
  assertCaseNotCanceled(financingCase);
  if (!actorUserId) {
    throw AppError.unprocessable('A dispensa de um item do checklist exige uma pessoa.', 'CASE_REQUIREMENT_VALIDATION_ACTOR_REQUIRED');
  }
  const reason = String(reasonText || '').trim();
  if (reason.length < 3) {
    throw AppError.badRequest('Informe o motivo da dispensa do item (mínimo 3 caracteres).', 'CASE_REQUIREMENT_DISMISS_REASON_REQUIRED');
  }
  if (reason.length > 500) {
    throw AppError.badRequest('O motivo da dispensa deve ter até 500 caracteres.', 'CASE_REQUIREMENT_DISMISS_REASON_REQUIRED');
  }
  const requirement = await CaseRequirement.findOne({ where: { id: requirementId, financingCaseId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!requirement) {
    throw AppError.notFound('Item de checklist não encontrado para este caso.', 'CASE_REQUIREMENT_NOT_FOUND');
  }
  if (!OPEN_REQUIREMENT_STATUSES.includes(requirement.status)) {
    throw AppError.unprocessable('Só um item pendente, enviado ou recusado pode ser dispensado.', 'CASE_REQUIREMENT_NOT_DISMISSIBLE');
  }
  const beforeStatus = requirement.status;
  requirement.status = 'DISPENSED';
  requirement.dismissedBy = actorUserId;
  requirement.dismissedAt = new Date();
  requirement.dismissReason = reason;
  requirement.updatedBy = actorUserId;
  await requirement.save({ transaction });

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.case_requirement.dismissed',
      entityType: 'CaseRequirement',
      entityId: requirement.id,
      beforeJson: { status: beforeStatus },
      afterJson: { status: 'DISPENSED' },
      reason: `Item "${docLabel(requirement.documentType)}" dispensado do checklist por uma pessoa: ${reason.slice(0, 300)}. Nada foi apagado.`,
    },
    transaction
  );
  await syncCaseChecklistStatus(financingCaseId, groupId, companyId, actorUserId, transaction);
  await publishDocumentsCompletedIfReady(financingCaseId, groupId, companyId, transaction);
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
 * listDocumentVersions — histórico completo de versões do documento de um item (vigente e superadas), com
 * arquivo, quem enviou, validade e leitura automática. Exige a permissão dedicada de documentos (controller).
 */
async function listDocumentVersions(financingCaseId, requirementId, actorContext, transaction) {
  const { groupId, companyId } = actorContext;
  await getCaseOrThrow(financingCaseId, groupId, companyId, transaction);
  const requirement = await CaseRequirement.findOne({ where: { id: requirementId, financingCaseId, groupId, companyId }, transaction });
  if (!requirement) {
    throw AppError.notFound('Item de checklist não encontrado para este caso.', 'CASE_REQUIREMENT_NOT_FOUND');
  }
  const versions = await CaseDocument.findAll({
    where: { requirementId, financingCaseId, groupId, companyId },
    include: [{ model: File, as: 'file', attributes: ['id', 'fileName', 'mimeType', 'sizeBytes', 'checksumSha256', 'scanStatus'] }],
    order: [['version', 'DESC']],
    transaction,
  });
  return {
    requirement: { id: requirement.id, documentType: requirement.documentType, status: requirement.status, validatedBy: requirement.status === CHECKLIST_COMPLETO ? requirement.updatedBy : null, updatedAt: requirement.updatedAt },
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      current: !v.supersededAt,
      supersededAt: v.supersededAt,
      expiresAt: v.expiresAt,
      uploadedBy: v.uploadedBy,
      createdAt: v.createdAt,
      sentToProviderAt: v.sentToProviderAt,
      suggestedNote: v.suggestedNote,
      file: v.file,
    })),
  };
}

/**
 * uploadDocument — registra uma nova VERSÃO de documento pro requirement. Nunca sobrescreve: se
 * já existe uma versão vigente (supersededAt IS NULL), ela é marcada como superada e uma nova
 * linha é criada com version+1 — histórico completo preservado (Caderno: "Documento substituído
 * preserva versão anterior").
 */
async function uploadDocument(financingCaseId, requirementId, payload, actorUserId, actorContext, transaction) {
  const { groupId, companyId } = actorContext;

  if (!requirementId) {
    throw AppError.badRequest('Informe a qual item do checklist este documento pertence.', 'CASE_DOCUMENT_VALIDATION');
  }
  const { fileId, expiresAt } = payload || {};
  if (!fileId) {
    throw AppError.badRequest('Envie o arquivo primeiro e informe o arquivo enviado.', 'CASE_DOCUMENT_VALIDATION');
  }
  const resolvedByDate = parseExpiresAt(expiresAt);

  // Leitura (OCR) e validação do arquivo ANTES de travar o caso e o item: a leitura é lenta e não segura trava.
  const preview = await CaseRequirement.findOne({ where: { id: requirementId, financingCaseId, groupId, companyId }, transaction });
  if (!preview) {
    throw AppError.notFound('Item de checklist não encontrado para este caso.', 'CASE_REQUIREMENT_NOT_FOUND');
  }
  const file = await File.findOne({ where: { id: fileId, groupId, companyId }, transaction });
  if (!file) {
    throw AppError.badRequest('Arquivo não encontrado nesta empresa — envie o arquivo antes de anexar.', 'CASE_DOCUMENT_FILE_NOT_FOUND');
  }
  // Um arquivo já usado como documento de outro item ou caso não pode ser reaproveitado aqui.
  const alreadyLinked = await CaseDocument.findOne({ where: { fileId }, transaction });
  if (alreadyLinked) {
    throw AppError.conflict('Este arquivo já foi anexado a outro item de documento. Envie um arquivo novo.', 'CASE_DOCUMENT_FILE_ALREADY_USED');
  }
  await sequelize.transaction({ transaction }, (nested) => assertContentMatchesDeclaredType(file, actorUserId, nested));
  const reading = await sequelize.transaction({ transaction }, (nested) =>
    readDocumentAutomatically(preview.documentType, file, actorUserId, nested)
  );

  const financingCase = await lockCase(financingCaseId, groupId, companyId, transaction);
  await assertCaseAcceptsAction(financingCase, 'document', transaction);
  const requirement = await CaseRequirement.findOne({ where: { id: requirementId, financingCaseId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!requirement) {
    throw AppError.notFound('Item de checklist não encontrado para este caso.', 'CASE_REQUIREMENT_NOT_FOUND');
  }
  if (requirement.status === 'EXPIRED') {
    throw AppError.unprocessable(
      'Este item venceu e foi substituído por um item novo e pendente do mesmo tipo. Envie o documento no item novo.',
      'CASE_REQUIREMENT_EXPIRED'
    );
  }
  if (requirement.status === 'DISPENSED') {
    throw AppError.unprocessable('Este item foi dispensado do checklist e não recebe documento.', 'CASE_REQUIREMENT_DISMISSED');
  }

  // Validade: a data informada vale; sem ela, o prazo em dias do tipo de documento (Parâmetros), se houver,
  // até o FIM do dia em Brasília (mesma regra da data informada).
  let resolvedExpiresAt = resolvedByDate;
  if (!resolvedExpiresAt) {
    const { peekEligibilityConfig } = require('../eligibility.service');
    const validity = (await peekEligibilityConfig(groupId, companyId, transaction)).documentValidityDays || {};
    const days = validity[requirement.documentType];
    if (Number.isInteger(days) && days > 0) {
      const target = new Date(Date.now() + days * 86400000);
      const dayInBrasilia = new Date(target.getTime() - 3 * 3600000).toISOString().slice(0, 10);
      resolvedExpiresAt = new Date(`${dayInBrasilia}T23:59:59-03:00`);
    }
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

  const suggestedNote = [buildSuggestedNote(requirement.documentType, file), reading?.note].filter(Boolean).join(' ') || null;

  const document = await CaseDocument.create(
    {
      groupId,
      companyId,
      financingCaseId,
      requirementId,
      fileId,
      version: nextVersion,
      classification: 'RESTRICTED',
      expiresAt: resolvedExpiresAt,
      uploadedBy: actorUserId || null,
      duplicateOfDocumentId,
      suggestedNote,
      // Sem leitor ativo (reading nulo) o documento fica NOT_READ: a validação exige conferência manual.
      readingStatus: reading?.status || 'NOT_READ',
      readingFoundFields: reading?.foundFields || [],
    },
    { transaction }
  );

  // Documentos ilegíveis viram uma tarefa para quem enviou (uma só em aberto por caso e tipo, com prazo).
  const taskTitle = `Revisar documento ilegível: ${docLabel(requirement.documentType)}`;
  const openTask = await Task.findOne({ where: { groupId, companyId, relatedEntityType: 'correspondent.financing_cases', relatedEntityId: financingCaseId, title: taskTitle, status: 'OPEN' }, transaction });
  if (reading?.illegible && !openTask) {
    await Task.create(
      {
        groupId,
        companyId,
        assignedToUserId: actorUserId || null,
        title: taskTitle,
        description: 'A leitura automática não conseguiu extrair dados do documento enviado. Peça um novo arquivo.',
        relatedEntityType: 'correspondent.financing_cases',
        relatedEntityId: financingCaseId,
        status: 'OPEN',
        priority: 'NORMAL',
        dueAt: new Date(Date.now() + 2 * 86400000),
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  } else if (!reading?.illegible && openTask) {
    // O documento foi substituído por um legível: a tarefa não faz mais sentido.
    openTask.status = 'DONE';
    openTask.updatedBy = actorUserId || null;
    await openTask.save({ transaction });
  }

  requirement.status = 'SUBMITTED';
  // Um novo envio limpa o aviso de recusa anterior (o motivo continua na auditoria e no histórico).
  if (requirement.notes && requirement.notes.startsWith('Documento recusado:')) requirement.notes = null;
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
      reason: `Documento restrito enviado (versão ${nextVersion}) para o item "${docLabel(requirement.documentType)}".` +
        (current ? ' Versão anterior preservada como superada.' : ''),
    },
    transaction
  );

  await syncCaseChecklistStatus(financingCaseId, groupId, companyId, actorUserId, transaction);
  return document;
}

/**
 * assertReadingAllowsValidation — a validação humana só passa se o documento é legível e se os campos
 * críticos do tipo foram encontrados na leitura ou informados por quem valida (`input.manualFields`,
 * conferidos no arquivo original). Devolve os campos informados à mão, já normalizados.
 */
async function assertReadingAllowsValidation(requirement, document, input) {
  if (!document) {
    throw AppError.unprocessable('Este item não tem documento enviado para validar.', 'CASE_REQUIREMENT_NOT_READY_TO_VALIDATE');
  }
  if (document.readingStatus === 'ILLEGIBLE') {
    throw AppError.unprocessable('A leitura automática não conseguiu ler este documento. Recuse o documento e peça um arquivo legível antes de validar.', 'CASE_REQUIREMENT_DOCUMENT_ILLEGIBLE');
  }
  const critical = CRITICAL_FIELDS_BY_DOCUMENT_TYPE[requirement.documentType] || [];
  const found = Array.isArray(document.readingFoundFields) ? document.readingFoundFields : [];
  const missing = critical.filter((field) => !found.includes(field));
  const manual = input && typeof input.manualFields === 'object' && input.manualFields ? input.manualFields : {};
  const entries = [];
  const stillMissing = [];
  for (const field of missing) {
    const raw = manual[field];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      stillMissing.push(field);
      continue;
    }
    entries.push([field, normalizeManualField(field, raw)]);
  }
  if (stillMissing.length) {
    throw AppError.unprocessable(
      `Não é possível validar: a leitura não encontrou ${stillMissing.map((f) => READING_FIELD_LABELS[f]).join(', ')} neste documento. Informe ${stillMissing.length > 1 ? 'esses dados' : 'esse dado'} conferindo o arquivo original, ou recuse o documento.`,
      'CASE_REQUIREMENT_CRITICAL_FIELDS_MISSING'
    );
  }
  return entries;
}

function normalizeManualField(field, raw) {
  const text = String(raw).trim();
  if (field === 'taxId') {
    const digits = text.replace(/\D/g, '');
    if (!isValidTaxIdDigits(digits)) {
      throw AppError.badRequest('O CPF/CNPJ informado é inválido. Confira os dígitos no arquivo original.', 'CASE_REQUIREMENT_MANUAL_FIELD_INVALID');
    }
    return digits;
  }
  if (field === 'income') {
    const value = Number(text.replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      throw AppError.badRequest('A renda informada precisa ser um valor maior que zero.', 'CASE_REQUIREMENT_MANUAL_FIELD_INVALID');
    }
    return value;
  }
  if (text.length < 3 || text.length > 120) {
    throw AppError.badRequest(`O campo ${READING_FIELD_LABELS[field]} informado precisa ter entre 3 e 120 caracteres.`, 'CASE_REQUIREMENT_MANUAL_FIELD_INVALID');
  }
  return text;
}

/**
 * validateRequirement — a validação humana do pipeline
 * "Upload → malware scan → hash → OCR/IA → sugestão → validação".
 * Só um ator humano valida um documento já enviado. A NAY não chama esta função.
 */
async function validateRequirement(financingCaseId, requirementId, actorUserId, actorContext, transaction, input = {}) {
  const { groupId, companyId } = actorContext;
  const financingCase = await lockCase(financingCaseId, groupId, companyId, transaction);
  assertCaseNotCanceled(financingCase);
  if (!actorUserId) {
    throw AppError.unprocessable('A validação do documento exige uma pessoa.', 'CASE_REQUIREMENT_VALIDATION_ACTOR_REQUIRED');
  }
  const requirement = await CaseRequirement.findOne({ where: { id: requirementId, financingCaseId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!requirement) {
    throw AppError.notFound('Item de checklist (requirement) não encontrado para este caso.', 'CASE_REQUIREMENT_NOT_FOUND');
  }
  if (requirement.status !== 'SUBMITTED') {
    throw AppError.unprocessable(
      'Só um documento já enviado pode ser validado.',
      'CASE_REQUIREMENT_NOT_READY_TO_VALIDATE'
    );
  }
  const currentDocument = await CaseDocument.findOne({ where: { requirementId, supersededAt: null }, transaction });
  if (currentDocument && currentDocument.expiresAt && new Date(currentDocument.expiresAt).getTime() < Date.now()) {
    throw AppError.unprocessable('A validade deste documento já passou. Peça um documento atualizado antes de validar.', 'CASE_REQUIREMENT_DOCUMENT_EXPIRED');
  }
  const { peekEligibilityConfig } = require('../eligibility.service');
  const config = await peekEligibilityConfig(groupId, companyId, transaction);
  if (config.validatorMustDifferFromUploader === true && currentDocument && currentDocument.uploadedBy && currentDocument.uploadedBy === actorUserId) {
    throw AppError.forbidden('Por regra da empresa, quem enviou o documento não pode validá-lo. Peça a outra pessoa.', 'CASE_REQUIREMENT_VALIDATOR_MUST_DIFFER');
  }

  const manualEntries = await assertReadingAllowsValidation(requirement, currentDocument, input);
  if (manualEntries.length && currentDocument) {
    currentDocument.suggestedNote = [currentDocument.suggestedNote, `Informado por quem validou, conferido no arquivo original: ${manualEntries.map(([key, value]) => `${READING_FIELD_LABELS[key]}: ${formatReadingValue(key, value)}`).join('; ')}.`].filter(Boolean).join(' ');
    await currentDocument.save({ transaction });
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
      afterJson: { status: requirement.status, documentType: requirement.documentType, readingStatus: currentDocument?.readingStatus || null, camposInformadosManualmente: manualEntries.map(([key]) => READING_FIELD_LABELS[key]) },
      reason: `Item "${docLabel(requirement.documentType)}" validado por uma pessoa.`,
    },
    transaction
  );

  await syncCaseChecklistStatus(financingCaseId, groupId, companyId, actorUserId, transaction);
  await publishDocumentsCompletedIfReady(financingCaseId, groupId, companyId, transaction);
  return requirement;
}

async function publishDocumentsCompletedIfReady(financingCaseId, groupId, companyId, transaction) {
  const totalRequired = await CaseRequirement.count({ where: { financingCaseId, groupId, companyId, required: true, status: { [Op.notIn]: NOT_COUNTED_STATUSES } }, transaction });
  const pendingRequired = await CaseRequirement.count({
    where: { financingCaseId, groupId, companyId, required: true, status: { [Op.notIn]: [CHECKLIST_COMPLETO, ...NOT_COUNTED_STATUSES] } },
    transaction,
  });
  if (totalRequired > 0 && pendingRequired === 0) {
    const financingCase = await getCaseOrThrow(financingCaseId, groupId, companyId, transaction);
    await publishFinancingDocumentsCompleted(financingCase, transaction);
  }
}

/**
 * rejectRequirement — a validação humana também pode RECUSAR: documento ilegível, errado ou
 * incompleto volta para "recusado" com o motivo, e o item aceita um novo envio (a versão recusada
 * continua preservada no histórico). Exige motivo e uma pessoa.
 */
async function rejectRequirement(financingCaseId, requirementId, reasonText, actorUserId, actorContext, transaction) {
  const { groupId, companyId } = actorContext;
  const financingCase = await lockCase(financingCaseId, groupId, companyId, transaction);
  assertCaseNotCanceled(financingCase);
  if (!actorUserId) {
    throw AppError.unprocessable('A recusa do documento exige uma pessoa.', 'CASE_REQUIREMENT_VALIDATION_ACTOR_REQUIRED');
  }
  const reason = String(reasonText || '').trim();
  if (reason.length < 3) {
    throw AppError.badRequest('Informe o motivo da recusa do documento (mínimo 3 caracteres).', 'CASE_REQUIREMENT_REJECT_REASON_REQUIRED');
  }
  const requirement = await CaseRequirement.findOne({ where: { id: requirementId, financingCaseId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!requirement) {
    throw AppError.notFound('Item de checklist (requirement) não encontrado para este caso.', 'CASE_REQUIREMENT_NOT_FOUND');
  }
  if (!['SUBMITTED', CHECKLIST_COMPLETO].includes(requirement.status)) {
    throw AppError.unprocessable('Só um documento já enviado pode ser recusado.', 'CASE_REQUIREMENT_NOT_READY_TO_REJECT');
  }
  const beforeStatus = requirement.status;
  requirement.status = 'REJECTED';
  requirement.notes = `Documento recusado: ${reason.slice(0, 400)}`;
  requirement.updatedBy = actorUserId;
  await requirement.save({ transaction });

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.case_requirement.rejected',
      entityType: 'CaseRequirement',
      entityId: requirement.id,
      beforeJson: { status: beforeStatus },
      afterJson: { status: 'REJECTED' },
      reason: `Documento "${docLabel(requirement.documentType)}" recusado por uma pessoa: ${reason.slice(0, 300)}. A versão enviada continua no histórico; um novo envio é permitido.`,
    },
    transaction
  );
  await syncCaseChecklistStatus(financingCaseId, groupId, companyId, actorUserId, transaction);
  return requirement;
}

/**
 * syncCaseChecklistStatus — sincroniza o status do caso com o checklist. Trava o caso (duas validações
 * simultâneas dos últimos itens se enxergam) e aplica o checklist mínimo da empresa (Parâmetros): tipo
 * exigido que ainda não está no checklist é criado como pendente.
 */
async function syncCaseChecklistStatus(financingCaseId, groupId, companyId, actorUserId, transaction) {
  const financingCase = await lockCase(financingCaseId, groupId, companyId, transaction);
  if (['CANCELED', 'REJECTED', 'COMPLETED'].includes(financingCase.status)) return financingCase;

  const { peekEligibilityConfig } = require('../eligibility.service');
  const config = await peekEligibilityConfig(groupId, companyId, transaction);
  const minimum = Array.isArray(config.requiredDocumentTypes) ? config.requiredDocumentTypes : [];
  if (minimum.length) {
    const existing = await CaseRequirement.findAll({ where: { financingCaseId, groupId, companyId, status: { [Op.ne]: 'EXPIRED' } }, attributes: ['documentType', 'applicantId'], transaction });
    const applicants = await CaseApplicant.findAll({ where: { financingCaseId, groupId, companyId }, attributes: ['id'], order: [['created_at', 'ASC']], transaction });
    for (const type of minimum) {
      // Com mais de um proponente, o documento pessoal é exigido de cada um (item geral, sem proponente, cobre todos).
      const owners = applicants.length > 1 && PERSONAL_DOCUMENT_TYPES.includes(type) ? applicants.map((a) => a.id) : [null];
      for (const ownerId of owners) {
        const covered = existing.some((r) => r.documentType === type && (r.applicantId === ownerId || r.applicantId === null || ownerId === null));
        if (covered) continue;
        // eslint-disable-next-line no-await-in-loop
        const seeded = await CaseRequirement.create(
          { groupId, companyId, financingCaseId, documentType: type, applicantId: ownerId, required: true, status: 'PENDING', notes: 'Exigido pelo checklist mínimo da empresa.', createdBy: actorUserId || null, updatedBy: actorUserId || null },
          { transaction }
        );
        existing.push({ documentType: type, applicantId: ownerId });
        // eslint-disable-next-line no-await-in-loop
        await registrarAuditoria(
          { groupId, companyId, actorUserId, action: 'correspondent.case_requirement.created', entityType: 'CaseRequirement', entityId: seeded.id, beforeJson: { registro: 'Não existia (registro criado nesta ação)' }, afterJson: { id: seeded.id, documentType: type, status: 'PENDING' }, reason: `Item "${docLabel(type)}" criado automaticamente: faz parte do checklist mínimo da empresa.` },
          transaction
        );
      }
    }
  }

  // Item vencido (EXPIRED) já foi substituído e item dispensado foi retirado por uma pessoa: não contam.
  const required = await CaseRequirement.findAll({
    where: { financingCaseId, groupId, companyId, required: true, status: { [Op.notIn]: NOT_COUNTED_STATUSES } },
    transaction,
  });
  if (required.length === 0) return financingCase;

  const allValidated = required.every((item) => item.status === CHECKLIST_COMPLETO);
  const target = allValidated ? 'READY_TO_SUBMIT' : 'DOCUMENTS_PENDING';
  // Caso "pronto para envio" que ganha um item pendente (documento novo ou vencido) volta a
  // "documentos pendentes": é o checklist interno, não uma regressão de status do provider.
  const reopensChecklist = financingCase.status === 'READY_TO_SUBMIT' && target === 'DOCUMENTS_PENDING';
  if (financingCase.status === target || (!reopensChecklist && !shouldApplyTransition(financingCase.status, target))) return financingCase;

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
    { previousStatus: beforeStatus, normalizedStatus: target, historyId: `checklist:${financingCase.id}:${target}:${crypto.randomUUID()}` },
    transaction
  );
  return financingCase;
}

module.exports = {
  DOCUMENT_TYPES,
  INCOMPLETE_REQUIREMENT_STATUSES,
  createRequirement,
  dismissRequirement,
  listRequirements,
  listDocumentVersions,
  uploadDocument,
  validateRequirement,
  rejectRequirement,
  syncCaseChecklistStatus,
};
