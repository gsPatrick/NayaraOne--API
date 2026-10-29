'use strict';

const crypto = require('crypto');
const { structureProblem } = require('./intake/intake.structure');
const { assertFreshTimestamp, derivedEventId } = require('./intake/intake.replay');
const { FORM } = require('./intake/intake.mediaType');

/**
 * Leitura do corpo SÓ DEPOIS da assinatura válida (M9-D211 passo 6): JSON.parse protegido, objeto na raiz, identificador do evento e tipo.
 * M9-D213: a conferência de horário/replay (401, antes do parse, usando o timestamp que o verificador devolve), os limites de estrutura (STRUCTURE_LIMIT) e o
 * esquema mínimo (id e tipo, SCHEMA_INVALID) entram em `payloadChecks`.
 * Motivos que levam o evento à fila morta (dead_letter_reason): INVALID_JSON, STRUCTURE_LIMIT, SCHEMA_INVALID, EVENT_ID_MISSING.
 */
const ID_KEYS = ['id', 'event_id', 'eventId', 'externalEventId', 'external_event_id'];
const TYPE_KEYS = ['type', 'event_type', 'eventType'];
const TENANT_KEYS = ['company_id', 'companyId', 'group_id', 'groupId'];
const ID_HEADERS = ['x-event-id', 'x-webhook-id'];
const TYPE_HEADER = 'x-event-type';

const asId = (v) => (typeof v === 'string' && v.trim() ? v.trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));
const first = (obj, keys) => keys.map((k) => asId(obj[k])).find(Boolean) || '';
const header = (headers, nome) => { const v = headers ? headers[nome] : undefined; return asId(Array.isArray(v) ? v[0] : v); };

/**
 * Verificações extras, na ordem de execução (M9-D213). `phase: 'pre'` roda ANTES de ler o JSON e pode lançar (replay: 401); `phase: 'post'` roda sobre o objeto
 * lido e devolve null ou { reason, detail } (o evento vai à fila morta com 200). `ctx`: { headers, verified, limits, now, rawBody, body }.
 */
const payloadChecks = [
  { name: 'replay', phase: 'pre', run: (ctx) => { assertFreshTimestamp(ctx.verified.timestamp, ctx.limits.timestampToleranceS, ctx.now); return null; } },
  { name: 'structure', phase: 'post', run: (ctx) => structureProblem(ctx.body, { maxDepth: ctx.limits.maxJsonDepth, maxKeys: ctx.limits.maxKeys, maxStringLength: ctx.limits.maxStringLength }) },
];

const LIMITES_PADRAO = Object.freeze({ timestampToleranceS: 300, maxJsonDepth: 20, maxKeys: 5000, maxStringLength: 100000 });

function readBody(rawBody, contentType) {
  if (contentType === FORM) return Object.fromEntries(new URLSearchParams(rawBody.toString('utf8')));
  return JSON.parse(rawBody.toString('utf8'));
}

/**
 * `opts`: limits (da empresa), contentType, now, requireEventType (padrão sim), deriveEventId (o fornecedor não manda id: sha256(fornecedor:horário:hash do corpo)), provider.
 * O evento sem tipo (corpo ou cabeçalho) é SCHEMA_INVALID: a rota só confere existência do id e do tipo; o formato fino é do worker (M9-D212).
 */
function parseEvent(rawBody, headers, verified = {}, opts = {}) {
  const limits = { ...LIMITES_PADRAO, ...(opts.limits || {}) };
  const base = { headers, verified, limits, now: opts.now || new Date(), rawBody };
  for (const check of payloadChecks.filter((c) => c.phase === 'pre')) check.run(base);
  let body;
  try {
    body = readBody(rawBody, opts.contentType);
  } catch {
    return { ok: false, reason: 'INVALID_JSON', detail: 'O corpo não é um JSON válido.' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'SCHEMA_INVALID', detail: 'A raiz do evento precisa ser um objeto.' };
  for (const check of payloadChecks.filter((c) => c.phase === 'post')) {
    const problema = check.run({ ...base, body });
    if (problema) return { ok: false, body, ...problema };
  }
  let eventId = asId(verified.eventId) || first(body, ID_KEYS) || ID_HEADERS.map((h) => header(headers, h)).find(Boolean) || '';
  if (!eventId && opts.deriveEventId) eventId = derivedEventId(opts.provider, verified.timestamp, crypto.createHash('sha256').update(rawBody).digest('hex'));
  if (!eventId || eventId.length > 160) return { ok: false, body, reason: 'EVENT_ID_MISSING', detail: 'O evento não traz um identificador externo.' };
  const eventType = first(body, TYPE_KEYS) || header(headers, TYPE_HEADER) || null;
  if (!eventType && opts.requireEventType !== false) return { ok: false, body, reason: 'SCHEMA_INVALID', detail: 'O evento não informa o tipo.' };
  return { ok: true, body, eventId, eventType };
}

/** Corpo que cita OUTRA empresa ou grupo que não os da connection do canal: o tenant vem sempre da connection (M9-D211 6). */
function foreignTenant(body, conn) {
  const citado = (chaves, esperado) => chaves.map((k) => asId(body[k])).filter(Boolean).some((v) => v.toLowerCase() !== String(esperado).toLowerCase());
  return citado(['company_id', 'companyId'], conn.companyId) || citado(['group_id', 'groupId'], conn.groupId);
}

/** Id do evento rejeitado: sha256(fornecedor:instante:hash do corpo), para o mesmo corpo recebido em instantes diferentes não colidir. */
const rejectedEventId = (provider, bodyHash, now = new Date()) => crypto.createHash('sha256').update(`${provider}:${now.toISOString()}:${bodyHash}`).digest('hex');

module.exports = { parseEvent, foreignTenant, rejectedEventId, payloadChecks, TENANT_KEYS };
