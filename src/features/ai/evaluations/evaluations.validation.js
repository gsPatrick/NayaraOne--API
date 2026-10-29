'use strict';

const E = require('./evaluations.errors');
const C = require('./evaluations.constants');
const { normalizeCode, validateIdempotencyKey } = require('../agents/agents.validation');
const { redactText } = require('../../../shared/redaction');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_RE = /^[a-z0-9][a-z0-9_.-]{1,59}$/;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function ctxOk(ctx) {
  if (!ctx || !ctx.groupId || !ctx.companyId) throw E.invalid('Contexto de empresa ausente.');
}

/** Corpo de POST /ai/evaluations/run: { agentCode, agentVersion?, suite: golden|adversarial|all, providerCode?, idempotencyKey? }. */
function parseRunBody(body) {
  if (!isObject(body)) throw E.invalid('Corpo da avaliação ausente.');
  const agentCode = normalizeCode(body.agentCode);
  if (!agentCode) throw E.invalid('Informe o código do agente (letras maiúsculas, números e _).');
  let agentVersion = null;
  if (body.agentVersion !== undefined && body.agentVersion !== null) {
    agentVersion = typeof body.agentVersion === 'string' && /^\d+$/.test(body.agentVersion) ? Number(body.agentVersion) : body.agentVersion;
    if (!Number.isInteger(agentVersion) || agentVersion < 1) throw E.invalid('Número de versão inválido.');
  }
  const suite = typeof body.suite === 'string' ? body.suite.trim().toUpperCase() : '';
  if (!C.SUITES.includes(suite)) throw E.invalid('Suíte inválida. Use golden, adversarial ou all.', { permitidas: ['golden', 'adversarial', 'all'] });
  let providerCode = C.SANDBOX_PROVIDER;
  if (body.providerCode !== undefined && body.providerCode !== null) {
    providerCode = typeof body.providerCode === 'string' ? body.providerCode.trim().toLowerCase() : '';
    if (!PROVIDER_RE.test(providerCode)) throw E.invalid('Código do provedor inválido.');
  }
  const idempotencyKey = body.idempotencyKey === undefined || body.idempotencyKey === null ? null : validateIdempotencyKey(body.idempotencyKey);
  return { agentCode, agentVersion, suite, providerCode, idempotencyKey };
}

/** Nota livre (homologação, decisão de candidato): texto redigido, até `max` caracteres; null se vazia. */
function parseNote(value, max, { required = false, onMissing } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    if (required) throw (onMissing ? onMissing() : E.invalid('Informe a nota.'));
    return null;
  }
  if (typeof value !== 'string') throw E.invalid('A nota deve ser um texto.');
  if (value.length > max) throw E.invalid(`A nota deve ter até ${max} caracteres.`);
  return redactText(value.trim());
}

module.exports = { ctxOk, isUuid, isObject, parseRunBody, parseNote };
