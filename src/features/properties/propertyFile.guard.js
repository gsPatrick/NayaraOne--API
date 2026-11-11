'use strict';

const { File } = require('../../models');
const AppError = require('../../utils/AppError');
const { getFileContent } = require('../files/files.service');
const { assertCanAttachFiles } = require('../files/fileAccess.service');
const { resolveAntivirusAdapter } = require('../people/adapters/resolveDocumentAdapters');

/**
 * Arquivo real do documento e da mídia do imóvel (verificação independente de 11/11/2026, M3-06 e CAD-06; livro do Marco 3 §6
 * "Media: Arquivo, ordem, classificação, qualidade" e §3 "property_documents: Matrícula, IPTU etc."). Antes, o documento era só
 * metadado e a mídia aceitava qualquer `storageKey` digitado, sem arquivo nem antivírus.
 *
 * resolveScannedPropertyFile: o arquivo precisa existir na empresa (RLS de people.files), quem vincula precisa poder lê-lo
 * (assertCanAttachFiles, a mesma regra de toda escrita que recebe id de arquivo), o tipo do arquivo precisa servir para o uso
 * (foto é imagem, vídeo é vídeo...) e o conteúdo é examinado de novo pelo antivírus no vínculo (o arquivo pode ter entrado por
 * um caminho que não examinava: anterior à coluna scan_status, gravado por integração). Infectado nunca vira documento nem mídia;
 * sem o binário, só segue se o arquivo já tiver sido liberado no envio (scan CLEAN).
 */
const UNAVAILABLE = ['FILE_CONTENT_NOT_FOUND', 'FILE_NOT_FOUND'];

const IMAGE = (mime) => mime.startsWith('image/');
const VIDEO = (mime) => mime.startsWith('video/');
const PDF = (mime) => mime === 'application/pdf';
const OFFICE = (mime) => mime.includes('msword') || mime.includes('officedocument') || mime.includes('ms-excel');

// Que tipo de arquivo cada uso aceita (o upload em si já é limitado pela allowlist de files.service).
const ACCEPT = Object.freeze({
  IMAGE: { test: IMAGE, label: 'imagem' },
  PHOTO: { test: IMAGE, label: 'imagem' },
  VIDEO: { test: VIDEO, label: 'vídeo' },
  FLOORPLAN: { test: (m) => IMAGE(m) || PDF(m), label: 'imagem ou PDF' },
  TOUR_360: { test: (m) => IMAGE(m) || VIDEO(m), label: 'imagem ou vídeo' },
  DOCUMENT: { test: (m) => IMAGE(m) || PDF(m) || OFFICE(m), label: 'PDF, imagem ou documento Office' },
});

async function scanContent(file, tenant, actorUserId, transaction) {
  let content = null;
  try {
    const withContent = await getFileContent(file.id, transaction, actorUserId, file);
    content = withContent.getDataValue('content');
  } catch (err) {
    if (!(err instanceof AppError) || !UNAVAILABLE.includes(err.code)) throw err;
  }
  if (!content) {
    if (file.scanStatus !== 'CLEAN') {
      throw AppError.unprocessable('O arquivo não pode ser examinado pelo antivírus (conteúdo indisponível) e não foi liberado no envio. Envie o arquivo de novo.', 'PROPERTY_FILE_NOT_SCANNED', { fileId: file.id });
    }
    return { clean: true, engine: 'upload', scannedAt: file.scannedAt ? new Date(file.scannedAt).toISOString() : null, checksumSha256: file.checksumSha256 || null };
  }
  const scan = await (await resolveAntivirusAdapter(tenant, transaction)).scan(content);
  if (!scan.clean) {
    throw AppError.unprocessable('O arquivo foi rejeitado pelo antivírus: assinatura de malware detectada. Nada foi vinculado ao imóvel.', 'PROPERTY_FILE_MALWARE_DETECTED', { fileId: file.id, signature: scan.signature });
  }
  return { clean: true, engine: scan.raw && scan.raw.sandbox ? 'sandbox' : 'clamav', scannedAt: new Date().toISOString(), checksumSha256: file.checksumSha256 || null };
}

/**
 * @param {string} fileId
 * @param {{ use: keyof ACCEPT, auth: object, tenant: {groupId, companyId}, actorUserId: string, transaction }} ctx
 * @returns {Promise<{ file, antivirus }>}
 */
async function resolveScannedPropertyFile(fileId, { use, auth, tenant, actorUserId, transaction }) {
  if (!fileId) {
    throw AppError.badRequest('Envie o arquivo antes (POST /files) e informe "fileId": documento e mídia do imóvel precisam do arquivo real.', 'PROPERTY_FILE_REQUIRED');
  }
  const file = await File.findByPk(fileId, { transaction });
  if (!file || file.companyId !== tenant.companyId) {
    throw AppError.notFound('Arquivo não encontrado nesta empresa.', 'PROPERTY_FILE_NOT_FOUND', { fileId });
  }
  await assertCanAttachFiles([file.id], auth, transaction);
  const accept = ACCEPT[use];
  const mime = String(file.mimeType || '').toLowerCase();
  if (accept && !accept.test(mime)) {
    throw AppError.badRequest(`O arquivo "${file.fileName}" (${mime || 'tipo desconhecido'}) não serve para este uso: envie ${accept.label}.`, 'PROPERTY_FILE_TYPE_MISMATCH', { fileId: file.id, mimeType: mime });
  }
  const antivirus = await scanContent(file, tenant, actorUserId, transaction);
  return { file, antivirus };
}

module.exports = { resolveScannedPropertyFile, ACCEPT };
