'use strict';

const crypto = require('crypto');
const { File } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

// 20MB — cobre foto, PDF, docx e um vídeo curto de vistoria. Acima disso o stopgap de guardar
// bytes direto no Postgres deixa de fazer sentido (precisaria de storage de objetos de verdade).
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * uploadFile — STOPGAP (ver migration 20260101000173/File.js): guarda o binário direto no
 * Postgres, já que não existe storage de objetos real neste sistema. Aceita o conteúdo como
 * base64 (mesmo formato já usado no adapter do Clicksign) para não depender de multipart/multer
 * (dependência que este projeto não tem instalada).
 */
async function uploadFile(payload, actorUserId, transaction) {
  const { groupId, companyId, fileName, mimeType, contentBase64 } = payload;
  if (!groupId || !companyId || !fileName || !contentBase64) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "fileName" e "contentBase64" são obrigatórios.',
      'FILE_UPLOAD_VALIDATION'
    );
  }

  let buffer;
  try {
    buffer = Buffer.from(String(contentBase64), 'base64');
  } catch (err) {
    throw AppError.badRequest('"contentBase64" não é um base64 válido.', 'FILE_UPLOAD_VALIDATION');
  }
  if (buffer.length === 0) {
    throw AppError.badRequest('O arquivo enviado está vazio.', 'FILE_UPLOAD_VALIDATION');
  }
  if (buffer.length > MAX_BYTES) {
    throw AppError.badRequest(
      `O arquivo excede o limite de ${MAX_BYTES / (1024 * 1024)}MB para este stopgap de storage.`,
      'FILE_UPLOAD_TOO_LARGE'
    );
  }

  const checksumSha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  const file = await File.create(
    {
      groupId,
      companyId,
      storageKey: `local-db/${groupId}/${crypto.randomUUID()}-${fileName}`,
      fileName,
      mimeType: mimeType || 'application/octet-stream',
      sizeBytes: buffer.length,
      checksumSha256,
      content: buffer,
      uploadedByUserId: actorUserId || null,
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
      action: 'files.upload',
      entityType: 'File',
      entityId: file.id,
      afterJson: { id: file.id, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.sizeBytes, checksumSha256 },
      reason: `Arquivo "${fileName}" enviado (${buffer.length} bytes).`,
    },
    transaction
  );

  // `defaultScope` (exclude content) só se aplica a queries (findAll/findByPk) — a instância
  // devolvida por `.create()` continua com `content` carregado em memória. Sem isso, a resposta
  // da API devolveria o binário inteiro de volta pro cliente em toda criação.
  file.setDataValue('content', undefined);
  return file;
}

/**
 * getFileContent — recupera o binário (via File.scope('withContent'), ver File.js) pra servir
 * de volta ao cliente. RLS de "people"."files" já garante que só o tenant dono enxerga a linha.
 */
async function getFileContent(id, transaction) {
  const file = await File.scope('withContent').findByPk(id, { transaction });
  if (!file) throw AppError.notFound('Arquivo não encontrado.', 'FILE_NOT_FOUND');
  if (!file.content) {
    throw AppError.notFound('Este arquivo não tem binário armazenado (metadado apenas).', 'FILE_CONTENT_NOT_FOUND');
  }
  return file;
}

/**
 * getFileMetadata — metadado puro (sem o binário), pra front decidir COMO exibir um arquivo
 * (visualizador universal: imagem, PDF, áudio, vídeo, download simples) antes de baixar os
 * bytes de verdade.
 */
async function getFileMetadata(id, transaction) {
  const file = await File.findByPk(id, { transaction });
  if (!file) throw AppError.notFound('Arquivo não encontrado.', 'FILE_NOT_FOUND');
  return file;
}

module.exports = { uploadFile, getFileContent, getFileMetadata, MAX_BYTES };
