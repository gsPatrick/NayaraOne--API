'use strict';

const crypto = require('crypto');
const { File } = require('../../../models');
const AppError = require('../../../utils/AppError');

/** Itens do manifesto do dossiê (livro §16, Guia §13): formato canônico, metadados do servidor e conferência de tipos. */
// §16 "Manifesto do dossiê lista arquivos, hashes, origem, datas, relações e versão": itens de
// arquivo trazem também fileId, nome original, data do arquivo, origem e versão do documento.
// Esses campos entram no hash na ordem fixa abaixo e SÓ quando existem no item, de modo que os
// pacotes antigos (4 campos) continuam com o mesmo hash.
const OPTIONAL_KEYS = ['fileId', 'originalName', 'createdAt', 'source', 'version'];

function normalizeManifest(manifest) {
  return (manifest || []).map((item) => {
    const out = {
      type: item.type,
      description: item.description,
      referenceId: item.referenceId !== undefined ? item.referenceId : null,
      hash: item.hash !== undefined ? item.hash : null,
    };
    for (const key of OPTIONAL_KEYS) if (item[key] !== undefined && item[key] !== null) out[key] = item[key];
    return out;
  });
}

const isoOf = (value) => (value ? new Date(value).toISOString() : null);

/** Metadados imutáveis do arquivo (Guia §13 getImmutableMetadata): sempre do servidor, nunca do chamador. */
function fileMetadata(file, source, extra = {}) {
  return { fileId: file.id, originalName: file.fileName, createdAt: isoOf(file.get('created_at') || file.get('createdAt')), source, ...extra };
}

/**
 * Pentest M5: objeto no lugar de texto/uuid ({"$gt":""}) virava 500. Tipos conferidos antes de qualquer consulta:
 * type/description texto não vazio; referenceId/hash/source texto ou nulo; fileId UUID em texto; version inteiro.
 */
function assertManifestItemTypes(item) {
  const bad = (field) => AppError.badRequest(`Item do manifesto: "${field}" com tipo inválido.`, 'LEGAL_EVIDENCE_PACKAGE_VALIDATION');
  for (const field of ['type', 'description']) if (typeof item[field] !== 'string' || !item[field].trim() || item[field].length > 500) throw bad(field);
  for (const field of ['referenceId', 'hash', 'source']) if (item[field] !== undefined && item[field] !== null && (typeof item[field] !== 'string' || item[field].length > 500)) throw bad(field);
  if (item.fileId !== undefined && item.fileId !== null && (typeof item.fileId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.fileId))) throw bad('fileId');
  if (item.version !== undefined && item.version !== null && !Number.isInteger(item.version)) throw bad('version');
}

/**
 * Item que cita um arquivo (fileId): hash, nome, data e ORIGEM vêm do servidor (Guia §13 getImmutableMetadata). A origem é
 * onde o arquivo está ligado no sistema (fileAccess.resolveFileOwnership), ou 'people.files' se ainda não tem vínculo; o item
 * montado pelo próprio servidor (assembleManifestFromContractAttachments) já traz a origem que ele mesmo leu.
 */
async function resolveFileItem(item, companyId, transaction) {
  if (!item.fileId) return item;
  const file = await File.findOne({ where: { id: item.fileId, companyId }, transaction });
  if (!file) throw AppError.badRequest(`Arquivo ${item.fileId} citado no manifesto não existe nesta empresa.`, 'LEGAL_EVIDENCE_PACKAGE_FILE_NOT_FOUND');
  let source = item[SERVER_ITEM] ? item.source : null;
  if (!source) {
    const { resolveFileOwnership } = require('../../../features/files/fileAccess.service');
    const { origins } = await resolveFileOwnership(file.id, transaction);
    source = origins.length ? origins.join(', ').slice(0, 500) : 'people.files';
  }
  return { ...item, hash: file.checksumSha256 || null, ...fileMetadata(file, source, item.version !== undefined ? { version: item.version } : {}) };
}

/**
 * Fechamento M5 (M5-A0207, Guia §13): a origem e o hash de cada item são do servidor, nunca do chamador. Item de arquivo tem tudo
 * lido do servidor (o `hash` e o `source` enviados são descartados, como já era com o hash); item sem arquivo (nota, referência
 * externa) tem o hash calculado aqui sobre o que foi declarado (tipo, descrição e referência) e a origem 'declaracao_manual'.
 */
const SERVER_ITEM = Symbol('evidenceServerItem');
const MANUAL_SOURCE = 'declaracao_manual';

function manualItem(item) {
  const declared = { type: item.type, description: item.description, referenceId: item.referenceId || null };
  const hash = crypto.createHash('sha256').update(JSON.stringify(declared)).digest('hex');
  return { ...declared, hash, source: MANUAL_SOURCE };
}

module.exports = { normalizeManifest, fileMetadata, assertManifestItemTypes, resolveFileItem, manualItem, SERVER_ITEM, MANUAL_SOURCE, OPTIONAL_KEYS };
