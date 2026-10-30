'use strict';

const crypto = require('node:crypto');
const { File } = require('../../../../models');
const diskStorage = require('../../../../utils/diskStorage');
const { encryptFileBuffer } = require('../../../../utils/fileCrypto');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const safe = (texto) => String(texto || 'nfse').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);

/**
 * Guarda o XML e o PDF oficiais da NFS-e em `files` (M9-D241 3.2 item 1), cifrados em repouso como os demais, com o SHA-256 na linha do arquivo. O mesmo conteúdo continua em
 * `finance.tax_documents` (hash conferido a cada download); aqui ele ganha o arquivo do módulo de arquivos, com dono e permissão. Devolve { xmlFile, pdfFile } (null quando não veio).
 */
async function storeInvoiceFiles({ groupId, companyId, documentNumber, documents }, transaction) {
  const out = { xmlFile: null, pdfFile: null };
  const grava = async (conteudo, ext, mime) => {
    if (!conteudo) return null;
    const buffer = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(String(conteudo), 'utf8');
    const fileName = `${safe(documentNumber)}.${ext}`;
    const storageKey = diskStorage.saveFile('finance-nfse', groupId, fileName, encryptFileBuffer(buffer));
    return File.create({ groupId, companyId, storageKey, fileName, mimeType: mime, sizeBytes: buffer.length, checksumSha256: sha256(buffer), uploadedByUserId: null, createdBy: null, updatedBy: null }, { transaction });
  };
  out.xmlFile = await grava(documents.xml, 'xml', 'application/xml');
  out.pdfFile = await grava(documents.pdf, 'pdf', 'application/pdf');
  return out;
}

module.exports = { storeInvoiceFiles };
