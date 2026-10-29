'use strict';

const logger = require('../../../utils/logger');
const { rateLimitCounter, rateLimitDisabledInProcess } = require('../../core-governance/api-governance/standards');
const { PADROES } = require('./webhooks.params');
const { rateLimited, rateUnavailable } = require('./webhooks.errors');

/**
 * Classe de limite WEBHOOK (M9-D211 passo 2), sobre o contador compartilhado da M9-D843 (governance.rate_limit_counters, janela de 60 s pelo relógio do
 * banco): por IP e fornecedor, ANTES de consultar a connection. Falha fechada: se o contador não responde, a rota pública recusa (503), não deixa passar.
 * O teto antes de saber a empresa é a variável de ambiente WEBHOOK_RATE_LIMIT_PER_MINUTE (10 a 100000) ou o padrão do parâmetro; depois que o canal
 * identifica a empresa, o parâmetro integration.webhook.rate_limit_per_minute dela pode apertar o limite (nunca afrouxar o teto).
 */
const MIN = 10;
const MAX = 100000;

function platformCeiling(env = process.env) {
  const n = Number(env.WEBHOOK_RATE_LIMIT_PER_MINUTE);
  return Number.isInteger(n) && n >= MIN && n <= MAX ? n : PADROES.rateLimitPerMinute;
}

const providerKey = (provider) => String(provider || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48) || '-';
const scopeKeyOf = (ip, provider) => `wh:${ip || 'sem-ip'}:${providerKey(provider)}`;

/** Conta a chamada e recusa acima do teto. Devolve { count } para a rota reaplicar o limite da empresa depois. */
async function checkWebhookRate(req, provider, res = null) {
  if (rateLimitDisabledInProcess()) return { count: 0, skipped: true };
  let state;
  try {
    state = await rateLimitCounter.hit(scopeKeyOf(req.ip, provider));
  } catch (err) {
    logger.warn({ err: err.message }, 'webhook.rateLimit.counter.failed');
    throw rateUnavailable();
  }
  if (state.count > platformCeiling()) {
    if (res) res.set('Retry-After', String(state.retryAfter));
    throw rateLimited(state.retryAfter);
  }
  return { count: state.count, retryAfter: state.retryAfter };
}

/** Depois de identificada a empresa: o limite dela, se mais apertado que o teto, vale sobre a contagem já feita. */
function enforceCompanyLimit(state, companyLimit, res = null) {
  if (!state || state.skipped) return;
  const limite = Math.min(platformCeiling(), companyLimit);
  if (state.count > limite) {
    if (res) res.set('Retry-After', String(state.retryAfter));
    throw rateLimited(state.retryAfter);
  }
}

module.exports = { checkWebhookRate, enforceCompanyLimit, platformCeiling, scopeKeyOf };
