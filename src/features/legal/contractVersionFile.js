'use strict';

const crypto = require('crypto');
const { File } = require('../../models');
const AppError = require('../../utils/AppError');
const diskStorage = require('../../utils/diskStorage');
const { encryptFileBuffer, decryptFileBuffer } = require('../../utils/fileCrypto');

/**
 * Arquivo armazenado da versão do contrato (Guia §4: `hash = sha256(rendered.bytes)` e
 * `fileId = files.store(rendered.bytes)`; Guia §6 `assertHashMatchesStoredFile`).
 * Os bytes do documento gerado/recebido viram um arquivo da empresa (cifrado em repouso, igual aos demais) e o
 * content_hash é o SHA-256 desses mesmos bytes. A aprovação relê o arquivo do armazenamento e confere o hash.
 */
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function storeVersionBytes(contract, versionNumber, bytes, actorUserId, transaction) {
  const safe = String(contract.contractNumber || contract.id).replace(/[^a-zA-Z0-9-]/g, '_');
  const fileName = `contrato-${safe}-v${versionNumber}.txt`;
  const storageKey = diskStorage.saveFile('contract-versions', contract.groupId, fileName, encryptFileBuffer(bytes));
  const hash = sha256(bytes);
  const file = await File.create({
    groupId: contract.groupId, companyId: contract.companyId, storageKey, fileName, mimeType: 'text/plain; charset=utf-8',
    sizeBytes: bytes.length, checksumSha256: hash, uploadedByUserId: actorUserId || null, createdBy: actorUserId || null, updatedBy: actorUserId || null,
  }, { transaction });
  return { file, hash };
}

/** Relê os bytes armazenados da versão e confere com o content_hash gravado (fail closed). */
async function assertHashMatchesStoredFile(version, transaction) {
  if (!version.contentFileId) {
    // Versão anterior ao arquivo armazenado (legado): confere o conteúdo gravado.
    if (!version.contentHash || sha256(Buffer.from(version.content || '', 'utf8')) !== version.contentHash) {
      throw AppError.conflict('O hash gravado da versão não corresponde ao conteúdo gravado: a versão não pode seguir.', 'LEGAL_CONTRACT_VERSION_HASH_MISMATCH');
    }
    return true;
  }
  const file = await File.findByPk(version.contentFileId, { transaction });
  let bytes;
  try {
    bytes = decryptFileBuffer(diskStorage.readFile(file.storageKey));
  } catch (err) {
    throw AppError.conflict('O arquivo armazenado da versão não pôde ser lido: a versão não pode ser aprovada.', 'LEGAL_CONTRACT_VERSION_FILE_UNREADABLE');
  }
  if (sha256(bytes) !== version.contentHash || file.checksumSha256 !== version.contentHash) {
    throw AppError.conflict('O hash do arquivo armazenado não corresponde ao hash da versão: a versão não pode seguir.', 'LEGAL_CONTRACT_VERSION_HASH_MISMATCH');
  }
  return true;
}

module.exports = { storeVersionBytes, assertHashMatchesStoredFile, sha256 };
