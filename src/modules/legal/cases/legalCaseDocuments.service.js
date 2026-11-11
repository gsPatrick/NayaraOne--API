'use strict';

const { File, FileLink } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { getLegalCase } = require('./legal-case.service');

/**
 * Documentos e provas do processo (Caderno M5 §14 "Documentos e provas ligados por
 * file_links/evidence"). O arquivo continua sendo o original enviado (people.files, SHA-256 do
 * upload, conferido a cada leitura); o processo só ganha um vínculo em people.file_links
 * (related_entity_type 'LegalCase', o mesmo tipo que a retenção legal M9-D912 já segue) — o
 * arquivo nunca é copiado nem regravado. O dossiê automático (evidencePackages.service.js) inclui
 * estes vínculos com o hash real do arquivo.
 */
const LINK_TYPE = 'LegalCase';
const PURPOSES = ['DOCUMENT', 'EVIDENCE', 'PETITION', 'DECISION', 'NOTICE', 'OTHER'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizePurpose(value) {
  if (value === undefined || value === null || value === '') return 'DOCUMENT';
  const purpose = String(value).trim().toUpperCase();
  if (!PURPOSES.includes(purpose)) {
    throw AppError.badRequest(`"purpose" deve ser um de: ${PURPOSES.join(', ')}.`, 'LEGAL_CASE_DOCUMENT_VALIDATION');
  }
  return purpose;
}

async function linkCaseDocument(legalCaseId, payload, actorUserId, transaction) {
  const legalCase = await getLegalCase(legalCaseId, transaction);
  const { fileId } = payload || {};
  if (!fileId || typeof fileId !== 'string' || !UUID_RE.test(fileId)) {
    throw AppError.badRequest('O campo "fileId" (UUID de um arquivo já enviado) é obrigatório.', 'LEGAL_CASE_DOCUMENT_VALIDATION');
  }
  const purpose = normalizePurpose(payload.purpose);
  // RLS: arquivo de outra empresa simplesmente não existe para quem chama.
  const file = await File.findOne({ where: { id: fileId, companyId: legalCase.companyId }, transaction });
  if (!file) throw AppError.notFound('Arquivo não encontrado.', 'LEGAL_CASE_DOCUMENT_FILE_NOT_FOUND');
  const existing = await FileLink.findOne({ where: { fileId, relatedEntityType: LINK_TYPE, relatedEntityId: legalCase.id }, transaction });
  if (existing) throw AppError.conflict('Este arquivo já está vinculado ao processo.', 'LEGAL_CASE_DOCUMENT_DUPLICATE');

  const link = await FileLink.create(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      fileId,
      relatedEntityType: LINK_TYPE,
      relatedEntityId: legalCase.id,
      purpose,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      actorUserId,
      action: 'legal.case.document_link',
      entityType: 'LegalCase',
      entityId: legalCase.id,
      beforeJson: { fileId, vinculado: false },
      afterJson: { vinculado: true, fileLinkId: link.id, fileId, purpose, fileName: file.fileName, checksumSha256: file.checksumSha256 },
      reason: `Arquivo "${file.fileName}" (${purpose}) vinculado ao processo ${legalCase.id}, SHA-256 ${file.checksumSha256 || 'não informado'}.`,
    },
    transaction
  );

  return { id: link.id, legalCaseId: legalCase.id, fileId, purpose, fileName: file.fileName, checksumSha256: file.checksumSha256, fileCreatedAt: file.get('created_at') || file.get('createdAt') || null };
}

async function listCaseDocuments(legalCaseId, transaction) {
  const legalCase = await getLegalCase(legalCaseId, transaction);
  const links = await FileLink.findAll({
    where: { relatedEntityType: LINK_TYPE, relatedEntityId: legalCase.id },
    include: [{ model: File, as: 'file' }],
    order: [['created_at', 'ASC']],
    transaction,
  });
  return links.map((link) => ({
    id: link.id,
    legalCaseId: legalCase.id,
    fileId: link.fileId,
    purpose: link.purpose,
    fileName: link.file ? link.file.fileName : null,
    checksumSha256: link.file ? link.file.checksumSha256 : null,
    fileCreatedAt: link.file ? link.file.get('created_at') || link.file.get('createdAt') || null : null,
    linkedAt: link.get('created_at') || link.get('createdAt') || null,
  }));
}

module.exports = { linkCaseDocument, listCaseDocuments, LINK_TYPE, PURPOSES };
