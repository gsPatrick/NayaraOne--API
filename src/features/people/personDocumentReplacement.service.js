'use strict';

const { PersonDocument, File } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getFileContent } = require('../files/files.service');
const { resolveOcrAdapter } = require('./adapters/resolveDocumentAdapters');

/**
 * Leitura do arquivo NOVO. Nunca herda a leitura do arquivo anterior: se o binario nao estiver
 * disponivel, a versao nasce sem campos lidos (quem verificar informa os dados conferindo o
 * original), e nunca com dado inventado.
 */
async function readReplacementFile(file, documentType, tenant, actorUserId, transaction) {
  let extraction;
  try {
    const withContent = await getFileContent(file.id, transaction, actorUserId, file);
    const ocr = await resolveOcrAdapter(tenant, transaction);
    extraction = await ocr.extract(withContent.getDataValue('content'), documentType);
  } catch (err) {
    if (!(err instanceof AppError) || !['FILE_CONTENT_NOT_FOUND', 'FILE_NOT_FOUND'].includes(err.code)) throw err;
    extraction = { fields: {}, confidence: 0, illegible: false, raw: { unavailable: true } };
  }
  return {
    fields: extraction.fields || {},
    sourceFileId: file.id,
    confidence: extraction.confidence,
    illegible: !!extraction.illegible,
    extractionMeta: extraction.raw || null,
  };
}

/**
 * replaceDocumentFile — auditoria da cliente (Marco 3): trocar o arquivo de um documento nao
 * pode manter versao, validacao e leitura do arquivo anterior. O original fica intacto e
 * consultavel; nasce a PROXIMA VERSAO do mesmo tipo, PENDENTE, com a leitura do arquivo novo,
 * que precisa ser confirmada por uma pessoa sobre o arquivo novo.
 */
async function replaceDocumentFile(original, payload, actorUserId, transaction) {
  if (payload.verificationStatus !== undefined) {
    throw AppError.unprocessable(
      'Ao trocar o arquivo, a nova versão nasce pendente. Troque o arquivo primeiro e confirme (verifique) a nova versão em seguida.',
      'PERSON_DOCUMENT_REPLACE_FILE_WITH_STATUS'
    );
  }
  const file = await File.findOne({ where: { id: payload.fileId, companyId: original.companyId }, transaction });
  if (!file) {
    throw AppError.badRequest('O arquivo informado não existe ou não pertence a esta empresa.', 'PERSON_DOCUMENT_FILE_NOT_FOUND');
  }
  // Carregado aqui porque personDocuments.service importa este modulo (dependencia circular).
  const { nextVersionNo } = require('./personDocuments.service');
  const documentType = String(payload.documentType || original.documentType).toUpperCase();
  const tenant = { groupId: original.groupId, companyId: original.companyId };
  const reading = await readReplacementFile(file, documentType, tenant, actorUserId, transaction);

  const created = await PersonDocument.create(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      personId: original.personId,
      documentType,
      fileId: file.id,
      versionNo: await nextVersionNo(original.personId, documentType, transaction),
      issuedAt: payload.issuedAt !== undefined ? payload.issuedAt : null,
      expiresAt: payload.expiresAt !== undefined ? payload.expiresAt : null,
      verificationStatus: 'PENDING',
      extractedDataJson: reading,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: created.groupId,
      companyId: created.companyId,
      actorUserId,
      action: 'people.document.replace_file',
      entityType: 'PersonDocument',
      entityId: created.id,
      beforeJson: original.toJSON(),
      afterJson: created.toJSON(),
      reason: `Arquivo do documento ${documentType} (versão ${original.versionNo}) substituído: o original foi preservado e a nova versão ${created.versionNo} nasceu pendente, com leitura e confirmação ligadas ao novo arquivo.`,
    },
    transaction
  );
  return created;
}

module.exports = { replaceDocumentFile };
