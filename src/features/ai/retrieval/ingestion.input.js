'use strict';

const crypto = require('node:crypto');
const E = require('./retrieval.errors');
const { SOURCE_KINDS, CLASSIFICATIONS } = require('./retrieval.constants');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const URL_MAX = 2048;

function ctxOk(ctx) {
  if (!ctx || !ctx.groupId || !ctx.companyId) throw E.invalid('Contexto de empresa ausente.');
}

/** UUID estável de uma URL na empresa (a URL não tem id): mesma empresa e mesma URL, sempre o mesmo `source_id`. */
function urlSourceId(companyId, url) {
  const h = crypto.createHash('sha256').update(`${companyId}|${url}`, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Entrada da ingestão: { sourceKind, sourceRef, classification?, reindex? }. FILE: sourceRef = id do arquivo; KNOWLEDGE_ENTRY: id da
 * entrada; URL: a URL (https). `classification` só vale para URL (arquivo e conhecimento têm a classificação no registro deles).
 */
function parseIngestInput(ctx, body) {
  ctxOk(ctx);
  const b = isObject(body) ? body : {};
  if (!SOURCE_KINDS.includes(b.sourceKind)) throw E.invalid('Informe o tipo da origem.', { permitidos: SOURCE_KINDS });
  const sourceRef = typeof b.sourceRef === 'string' ? b.sourceRef.trim() : '';
  if (!sourceRef || sourceRef.length > URL_MAX) throw E.invalid('Informe a origem a indexar.');
  if (b.sourceKind !== 'URL' && !isUuid(sourceRef)) throw E.invalid('A origem deve ser o identificador de um arquivo ou de um conhecimento.');
  if (b.classification !== undefined && b.classification !== null && !CLASSIFICATIONS.includes(b.classification)) {
    throw E.invalid('Classificação inválida.', { permitidos: CLASSIFICATIONS });
  }
  const sourceId = b.sourceKind === 'URL' ? urlSourceId(ctx.companyId, sourceRef) : sourceRef.toLowerCase();
  return { sourceKind: b.sourceKind, sourceRef: b.sourceKind === 'URL' ? sourceRef : sourceId, sourceId, classification: b.classification || null, reindex: b.reindex === true };
}

module.exports = { isUuid, ctxOk, urlSourceId, parseIngestInput };
