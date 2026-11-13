'use strict';

const { PersonDocument, File } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getFileContent } = require('../files/files.service');
const { resolvePersonDocumentEngines, READING_UNAVAILABLE } = require('./personDocumentEngines');
const { readDocumentParams } = require('./personDocument.settings');

const UNAVAILABLE = ['FILE_CONTENT_NOT_FOUND', 'FILE_NOT_FOUND'];

/**
 * Antivírus e leitura do arquivo NOVO, na própria troca (pedido da cliente, Marco 3: "o novo arquivo passa por
 * antivírus, leitura e revisão próprias"). Ordem do caderno §5: antivírus -> hash (getFileContent confere o SHA-256
 * gravado) -> OCR/IA. O arquivo pode ter vindo de um caminho que nunca passou pelo antivírus (arquivo anterior à
 * coluna scan_status, XML de NFS-e, evidência de assinatura): por isso o conteúdo é examinado de novo aqui, e infectado
 * nunca vira versão. Sem o binário não há o que examinar: só segue se o arquivo já tiver sido liberado (scan CLEAN).
 * A leitura nunca herda a do arquivo anterior: sem binário, a versão nasce sem campos lidos, nunca com dado inventado.
 */
async function scanAndReadReplacementFile(file, documentType, tenant, actorUserId, transaction, params) {
  const engines = resolvePersonDocumentEngines(params); // mesmos motores e a mesma trava do envio (CAD-05, DI-M3PE-6)
  let content = null;
  try {
    const withContent = await getFileContent(file.id, transaction, actorUserId, file);
    content = withContent.getDataValue('content');
  } catch (err) {
    if (!(err instanceof AppError) || !UNAVAILABLE.includes(err.code)) throw err;
  }
  let antivirus;
  if (content) {
    const scan = await engines.antivirus.scan(content);
    if (!scan.clean) {
      throw AppError.unprocessable('O arquivo novo foi rejeitado pelo antivírus: assinatura de malware detectada. A troca não foi feita e o documento original continua valendo.', 'PERSON_DOCUMENT_FILE_MALWARE_DETECTED', { signature: scan.signature });
    }
    antivirus = { clean: true, scannedAt: new Date().toISOString(), engine: scan.raw && scan.raw.sandbox ? 'sandbox' : 'clamav', checksumSha256: file.checksumSha256 || null };
  } else if (file.scanStatus !== 'CLEAN') {
    throw AppError.unprocessable('O arquivo novo não pode ser examinado pelo antivírus (conteúdo indisponível) e não foi liberado antes. A troca não foi feita.', 'PERSON_DOCUMENT_FILE_NOT_SCANNED');
  } else {
    antivirus = { clean: true, scannedAt: file.scannedAt ? new Date(file.scannedAt).toISOString() : null, engine: 'upload', checksumSha256: file.checksumSha256 || null };
  }
  let extraction = { fields: {}, confidence: 0, illegible: false, raw: { unavailable: true } };
  if (content) extraction = engines.leitor ? await engines.leitor.extract(content, documentType) : READING_UNAVAILABLE;
  return {
    fields: extraction.fields || {},
    sourceFileId: file.id,
    confidence: extraction.confidence,
    illegible: !!extraction.illegible,
    extractionMeta: extraction.raw || null,
    antivirus,
  };
}

// Mesma régua do envio (documentIngestion.service.js): ilegível, baixa confiança ou campo crítico ausente/inválido
// abrem pendência de revisão do arquivo novo. Carregado aqui por causa da dependência circular entre os services.
function pendingReasonFor(reading, documentType, params) {
  if (reading.extractionMeta && reading.extractionMeta.reason === 'LEITURA_INDISPONIVEL') return 'Leitura automática indisponível neste servidor: confira os dados do arquivo novo no original.';
  if (reading.extractionMeta && reading.extractionMeta.unavailable) return 'Conteúdo do arquivo novo indisponível para leitura automática: confira os dados no original.';
  const { reviewPendingReason } = require('./documentIngestion.service');
  try {
    return reviewPendingReason(reading, documentType, params);
  } catch (err) {
    if (err instanceof AppError) return `Campos críticos inválidos na leitura do arquivo novo: ${err.message}`;
    throw err;
  }
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
  const params = await readDocumentParams(tenant, transaction);
  const reading = await scanAndReadReplacementFile(file, documentType, tenant, actorUserId, transaction, params);

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

  const pendingReason = pendingReasonFor(reading, documentType, params);
  if (pendingReason) {
    const { openReviewTask } = require('./documentIngestion.service');
    await openReviewTask({ ...tenant, personId: original.personId, actorUserId, title: `Revisar nova versão ${created.versionNo} do documento ${documentType} (arquivo trocado)`, reason: pendingReason }, transaction);
  }

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
      reason: `Arquivo do documento ${documentType} (versão ${original.versionNo}) substituído: o original foi preservado e a nova versão ${created.versionNo} nasceu pendente, com antivírus, leitura e confirmação ligadas ao novo arquivo${pendingReason ? `; revisão pendente: ${pendingReason}` : ''}.`,
    },
    transaction
  );
  return created;
}

module.exports = { replaceDocumentFile };
