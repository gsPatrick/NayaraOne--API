'use strict';

const E = require('./runs.errors');
const C = require('./runs.constants');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Teto só contra abuso: o resumo é redigido e cortado no limite do parâmetro por auditSanitizer (M9-D028), nunca recusado por tamanho.
const RAW_TEXT_MAX = 500000;
const HASH_RE = /^[0-9a-f]{64}$/;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function ctxOk(ctx) {
  if (!ctx || !ctx.groupId || !ctx.companyId) throw E.invalid('Contexto de empresa ausente.');
}

function text(value, nome, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw E.invalid(`${nome} é obrigatório.`);
    return null;
  }
  if (typeof value !== 'string') throw E.invalid(`${nome} deve ser um texto.`);
  if (value.length > max) throw E.invalid(`${nome} deve ter até ${max} caracteres.`);
  return value;
}

function oneOf(value, lista, nome, { fallback } = {}) {
  if (value === undefined || value === null) return fallback === undefined ? undefined : fallback;
  if (!lista.includes(value)) throw E.invalid(`${nome} inválido.`, { permitidos: lista });
  return value;
}

function count(value, nome) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0) throw E.invalid(`${nome} deve ser um inteiro maior ou igual a zero.`);
  return value;
}

function unit(value, nome) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw E.invalid(`${nome} deve estar entre 0 e 1.`);
  return n;
}

function date(value, nome) {
  if (value === undefined || value === null) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw E.invalid(`${nome} deve ser uma data válida.`);
  return d;
}

function hash(value, nome) {
  if (value === undefined || value === null) return null;
  if (!HASH_RE.test(value)) throw E.invalid(`${nome} deve ser um sha256 em hexadecimal.`);
  return value;
}

function trail(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((s) => !isObject(s) || typeof s.from !== 'string' || typeof s.to !== 'string' || typeof s.reason !== 'string')) {
    throw E.invalid('fallbackTrail deve ser uma lista de saltos {from, to, reason}.');
  }
  return value.map((s) => ({ from: s.from, to: s.to, reason: s.reason }));
}

/** Entrada de startRun: normalizada, sem aceitar campo fora da lista. */
function parseStart(data = {}) {
  const stamp = data.stamp || {};
  const agentName = text(stamp.agentCode || data.agentName, 'O agente', 64, { required: true });
  return {
    agentName,
    agentId: stamp.agentId === undefined ? null : stamp.agentId,
    agentVersion: stamp.agentVersion === undefined ? null : count(stamp.agentVersion, 'A versão do agente'),
    purpose: text(data.purpose, 'A finalidade', 200),
    inputSummary: text(data.inputSummary, 'O resumo da entrada', RAW_TEXT_MAX),
    idempotencyKey: text(data.idempotencyKey, 'A chave de idempotência', 200),
    requestHash: hash(data.requestHash, 'requestHash'),
    parentRunId: data.parentRunId === undefined ? null : data.parentRunId,
    snapshotAt: date(data.snapshotAt, 'snapshotAt') || null,
    correlationId: data.correlationId || null,
    routingPath: oneOf(data.routingPath, C.ROUTING_PATHS, 'O caminho de roteamento', { fallback: 'RULE' }),
  };
}

/** Entrada de finishRun: só os campos presentes entram no UPDATE. */
function parseFinish(data = {}) {
  const status = oneOf(data.status, C.STATUSES.filter((s) => s !== 'RUNNING'), 'O estado de destino');
  if (!status) throw E.invalid('O estado de destino é obrigatório.');
  const out = { status };
  const put = (k, v) => { if (v !== undefined) out[k] = v; };
  put('outputSummary', text(data.outputSummary, 'O resumo da saída', RAW_TEXT_MAX) ?? undefined);
  put('providerCode', text(data.providerCode, 'O provider', 60) ?? undefined);
  put('modelCode', text(data.modelCode, 'O modelo', 120) ?? undefined);
  put('routingPath', oneOf(data.routingPath, C.ROUTING_PATHS, 'O caminho de roteamento'));
  put('groundingStatus', oneOf(data.groundingStatus, C.GROUNDING, 'O estado de aterramento'));
  put('tokensIn', count(data.tokensIn, 'tokensIn'));
  put('tokensOut', count(data.tokensOut, 'tokensOut'));
  put('latencyMs', count(data.latencyMs, 'latencyMs'));
  put('confidence', unit(data.confidence, 'A confiança'));
  put('blockedReason', text(data.blockedReason, 'O motivo do bloqueio', 120) ?? undefined);
  put('errorCode', text(data.errorCode, 'O código do erro', 80) ?? undefined);
  put('fallbackTrail', trail(data.fallbackTrail));
  put('snapshotAt', date(data.snapshotAt, 'snapshotAt'));
  for (const k of ['escalated', 'cached']) {
    if (data[k] !== undefined) { if (typeof data[k] !== 'boolean') throw E.invalid(`${k} deve ser verdadeiro ou falso.`); out[k] = data[k]; }
  }
  if (data.costAmount !== undefined && data.costAmount !== null) {
    if (!/^\d+(\.\d{1,6})?$/.test(String(data.costAmount))) throw E.invalid('costAmount deve ser decimal com até seis casas.');
    out.costAmount = String(data.costAmount);
  }
  out.priceIn = data.priceIn;
  out.priceOut = data.priceOut;
  if (status === 'BLOCKED' && !out.blockedReason) throw E.invalid('Execução bloqueada precisa do motivo (blockedReason).');
  if (out.cached === true) out.routingPath = 'CACHE';
  return out;
}

function parseSource(data = {}) {
  const d = isObject(data) ? data : {};
  const sourceType = oneOf(d.sourceType, C.SOURCE_TYPES, 'O tipo da fonte');
  if (!sourceType) throw E.invalid('O tipo da fonte é obrigatório.', { permitidos: C.SOURCE_TYPES });
  return {
    sourceType,
    sourceRef: text(d.sourceRef, 'A referência da fonte', 255),
    sourceVersion: text(d.sourceVersion, 'A versão da fonte', 60),
    excerpt: text(d.excerpt, 'O trecho', 1000000),
    classification: oneOf(d.classification, C.CLASSIFICATIONS, 'A classificação', { fallback: 'INTERNAL' }),
    effectiveFrom: date(d.effectiveFrom, 'effectiveFrom') || null,
    effectiveUntil: date(d.effectiveUntil, 'effectiveUntil') || null,
    retrievedAt: date(d.retrievedAt, 'retrievedAt') || undefined,
    relevanceScore: unit(d.relevanceScore, 'A relevância') ?? null,
    usedInAnswer: d.usedInAnswer === true,
    statusAtRetrieval: oneOf(d.statusAtRetrieval, C.SOURCE_STATUSES, 'O estado da fonte', { fallback: 'VIGENTE' }),
    contentHash: hash(d.contentHash, 'contentHash'),
  };
}

module.exports = { ctxOk, isUuid, parseStart, parseFinish, parseSource };
