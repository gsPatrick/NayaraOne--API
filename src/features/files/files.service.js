'use strict';

const crypto = require('crypto');
const { File } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const diskStorage = require('../../utils/diskStorage');

// 20MB — cobre foto, PDF, docx e um vídeo curto de vistoria.
const MAX_BYTES = 20 * 1024 * 1024;

// Categorias reconhecidas de uploads/<categoria>/ — usadas pra organizar o disco por tipo de
// documento (levantado lendo todos os usos reais de File no código: inspections media, laudos
// de vistoria, documentos de pessoa, documentos de imóvel, contratos). "generic" é o default
// pra quem não informar `category` no payload (compatibilidade com chamadores antigos).
// "contracts-signed" é usada só internamente por signatures.service.js#handleEnvelopeClosedWebhook
// (documento assinado baixado do provedor) — não é um upload manual via este service, mas
// listada aqui pra manter a validação de categoria centralizada.
const KNOWN_CATEGORIES = ['contracts', 'contracts-signed', 'inspections', 'people-documents', 'property-documents', 'generic'];

function resolveCategory(category) {
  if (category && KNOWN_CATEGORIES.includes(category)) return category;
  return 'generic';
}

/**
 * uploadFile — grava o binário em disco (uploads/<category>/<groupId>/..., ver
 * src/utils/diskStorage.js) e persiste em File apenas o `storageKey` (caminho relativo) e os
 * metadados de integridade (sizeBytes/checksumSha256 calculados sobre o buffer decodificado).
 * A coluna `content` (BLOB) NÃO é mais escrita em uploads novos — ela continua existindo no
 * schema só pra servir de fallback de leitura de arquivos antigos já gravados nela (ver
 * getFileContent). Aceita o conteúdo como base64 (mesmo formato já usado no adapter do
 * Clicksign) para não depender de multipart/multer (dependência que este projeto não tem
 * instalada).
 */
async function uploadFile(payload, actorUserId, transaction) {
  const { groupId, companyId, fileName, mimeType, contentBase64, category } = payload;
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
      `O arquivo excede o limite de ${MAX_BYTES / (1024 * 1024)}MB.`,
      'FILE_UPLOAD_TOO_LARGE'
    );
  }

  const checksumSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const storageKey = diskStorage.saveFile(resolveCategory(category), groupId, fileName, buffer);

  const file = await File.create(
    {
      groupId,
      companyId,
      storageKey,
      fileName,
      mimeType: mimeType || 'application/octet-stream',
      sizeBytes: buffer.length,
      checksumSha256,
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
 * getFileContent — recupera o binário pra servir de volta ao cliente. RLS de "people"."files"
 * já garante que só o tenant dono enxerga a linha.
 *
 * Caminho novo (storageKey aponta pra uploads/): lê do disco via diskStorage.readFile.
 * Fallback de compatibilidade (arquivos ANTIGOS gravados antes desta migração de storage):
 * storageKey ainda começa com "local-db/" e o binário está no BLOB `content` do Postgres — lê
 * de lá via File.scope('withContent'). Não dá pra simplesmente reprocessar esses arquivos
 * antigos pro disco aqui (efeito colateral de leitura), então o fallback fica permanente até
 * uma eventual migração de dados que mova esse binário legado pro disco.
 */
async function getFileContent(id, transaction) {
  const metadata = await File.findByPk(id, { transaction });
  if (!metadata) throw AppError.notFound('Arquivo não encontrado.', 'FILE_NOT_FOUND');

  if (metadata.storageKey && metadata.storageKey.startsWith('local-db/')) {
    const legacy = await File.scope('withContent').findByPk(id, { transaction });
    if (!legacy || !legacy.content) {
      throw AppError.notFound('Este arquivo não tem binário armazenado (metadado apenas).', 'FILE_CONTENT_NOT_FOUND');
    }
    return legacy;
  }

  let buffer;
  try {
    buffer = diskStorage.readFile(metadata.storageKey);
  } catch (err) {
    throw AppError.notFound('Arquivo não encontrado em disco.', 'FILE_CONTENT_NOT_FOUND');
  }
  metadata.setDataValue('content', buffer);
  return metadata;
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
