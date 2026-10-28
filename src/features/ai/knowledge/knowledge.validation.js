'use strict';

const crypto = require('node:crypto');
const E = require('./knowledge.errors');
const { CLASSIFICATIONS, FACT_KEY_RE, SUBJECT_TYPE_RE, STATUSES } = require('./knowledge.constants');
const { containsSecret } = require('../guards/secretPatterns');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function ctxOk(ctx) {
  if (!ctx || !ctx.groupId || !ctx.companyId) throw E.invalid('Contexto de empresa ausente.');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((acc, k) => { acc[k] = canonical(value[k]); return acc; }, {});
  return value;
}

/** sha256 do conteúdo que o RAG vai ler (chaves ordenadas): o mesmo conteúdo dá sempre o mesmo hash. */
function computeContentHash(c) {
  const texto = JSON.stringify(canonical({
    factKey: c.factKey, subjectType: c.subjectType, subjectId: c.subjectId || null, title: c.title, value: c.value, bodyStructured: c.bodyStructured || null,
    classification: c.classification, validFrom: c.validFrom ? new Date(c.validFrom).toISOString() : null, validUntil: c.validUntil ? new Date(c.validUntil).toISOString() : null,
  }));
  return crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
}

function date(value, nome) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw E.invalid(`${nome} deve ser uma data válida.`);
  return d;
}

function uuidOrNull(value, nome) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isUuid(value)) throw E.invalid(`${nome} deve ser um identificador válido.`);
  return value;
}

/** Corpo do cadastro/edição. `partial` (edição de DRAFT) aceita só os campos presentes; no cadastro os obrigatórios têm de vir. */
function parseContent(body, { partial = false } = {}) {
  const b = isObject(body) ? body : null;
  if (!b) throw E.invalid('Corpo inválido.');
  const out = {};
  const need = (cond, msg) => { if (!cond) throw E.invalid(msg); };
  if (b.factKey !== undefined || !partial) {
    need(typeof b.factKey === 'string' && FACT_KEY_RE.test(b.factKey), 'A chave do fato (factKey) é obrigatória: minúsculas, números e . _ : -, de 3 a 128 caracteres.');
    out.factKey = b.factKey;
  }
  if (b.subjectType !== undefined || !partial) {
    need(typeof b.subjectType === 'string' && SUBJECT_TYPE_RE.test(b.subjectType), 'O tipo do assunto (subjectType) é obrigatório.');
    out.subjectType = b.subjectType;
  }
  if (b.title !== undefined || !partial) {
    need(typeof b.title === 'string' && b.title.trim().length > 0 && b.title.length <= 200, 'O título é obrigatório e deve ter até 200 caracteres.');
    out.title = b.title.trim();
  }
  if (b.value !== undefined || !partial) {
    need(b.value !== undefined && b.value !== null && (isObject(b.value) || Array.isArray(b.value) || typeof b.value === 'string' || typeof b.value === 'number' || typeof b.value === 'boolean'), 'O valor do fato (value) é obrigatório.');
    out.value = b.value;
  }
  if (b.classification !== undefined || !partial) {
    need(CLASSIFICATIONS.includes(b.classification), 'A classificação é obrigatória: PUBLIC, INTERNAL, CONFIDENTIAL ou RESTRICTED.');
    out.classification = b.classification;
  }
  if (b.bodyStructured !== undefined) {
    need(b.bodyStructured === null || isObject(b.bodyStructured) || Array.isArray(b.bodyStructured), 'O corpo estruturado deve ser um objeto ou uma lista.');
    out.bodyStructured = b.bodyStructured;
  }
  if (b.origin !== undefined) { need(b.origin === null || (typeof b.origin === 'string' && b.origin.length <= 64), 'A origem deve ter até 64 caracteres.'); out.origin = b.origin; }
  for (const [chave, nome] of [['subjectId', 'O assunto (subjectId)'], ['ownerUserId', 'O responsável (ownerUserId)'], ['sourceId', 'A origem (sourceId)']]) {
    const v = uuidOrNull(b[chave], nome);
    if (v !== undefined) out[chave] = v;
  }
  for (const [chave, nome] of [['validFrom', 'validFrom'], ['validUntil', 'validUntil']]) {
    const v = date(b[chave], nome);
    if (v !== undefined) out[chave] = v;
  }
  return out;
}

/** Recusa texto que pareça credencial em qualquer campo de conteúdo (400 AI_KNOWLEDGE_SECRET_DETECTED). */
function assertNoSecret(content) {
  const alvo = [content.title, content.value, content.bodyStructured, content.origin];
  if (alvo.some((v) => v !== undefined && containsSecret(v))) throw E.secretDetected();
}

function parseFilters(query = {}) {
  const f = {};
  if (query.status !== undefined) { if (!STATUSES.includes(query.status)) throw E.invalid('Estado inválido.'); f.status = query.status; }
  if (query.factKey !== undefined) { if (typeof query.factKey !== 'string' || !FACT_KEY_RE.test(query.factKey)) throw E.invalid('Chave do fato inválida.'); f.factKey = query.factKey; }
  if (query.classification !== undefined) { if (!CLASSIFICATIONS.includes(query.classification)) throw E.invalid('Classificação inválida.'); f.classification = query.classification; }
  return f;
}

function parseReason(body) {
  const reason = isObject(body) && typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw E.invalid('O motivo da revogação é obrigatório.');
  if (reason.length > 2000) throw E.invalid('O motivo deve ter até 2000 caracteres.');
  if (containsSecret(reason)) throw E.secretDetected();
  return reason;
}

module.exports = { ctxOk, isUuid, computeContentHash, parseContent, assertNoSecret, parseFilters, parseReason };
