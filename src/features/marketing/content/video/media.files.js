'use strict';

const { getFileMetadata } = require('../../../files/files.service');

/**
 * Metadado do arquivo no módulo de arquivos (M9-D426), lido só pelo serviço dele (o serviço de conteúdo não consulta tabela de outra área). Devolve
 * { id, file_name, mime_type, size_bytes, checksum_sha256, scan_status } ou null se o arquivo não existe para a empresa (RLS).
 */
async function fileInfo(fileId, transaction) {
  try {
    const file = await getFileMetadata(fileId, transaction);
    return { id: file.id, file_name: file.fileName, mime_type: file.mimeType, size_bytes: file.sizeBytes, checksum_sha256: file.checksumSha256, scan_status: file.scanStatus };
  } catch (err) {
    if (err.code === 'FILE_NOT_FOUND') return null;
    throw err;
  }
}

module.exports = { fileInfo };
