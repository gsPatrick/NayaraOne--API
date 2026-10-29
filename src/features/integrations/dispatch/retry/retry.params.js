'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { RETRY_LIMITS } = require('./retry.limits');

/** Padrões do livro (M9-D216 3.2) e das decisões DI-D216-*: usados quando a empresa não configurou. */
const PADROES = Object.freeze({ base_delay_ms: 5000, factor: 2, cap_delay_ms: 1800000, max_attempts: 8, jitter_pct: 25, rate_limit_max_wait_s: 3600, rate_limit_max_deferrals: 100 });
const CHAVES = Object.freeze({
  base_delay_ms: 'integration.retry.base_delay_ms', factor: 'integration.retry.factor', cap_delay_ms: 'integration.retry.cap_delay_ms',
  max_attempts: 'integration.retry.max_attempts', jitter_pct: 'integration.retry.jitter_pct', rate_limit_max_wait_s: 'integration.retry.rate_limit_max_wait_s',
  rate_limit_max_deferrals: 'integration.retry.rate_limit_max_deferrals',
});
const LIMITES = Object.freeze({ ...RETRY_LIMITS, rate_limit_max_deferrals: { min: 1, max: 10000 } });

const valido = (campo, v) => Number.isInteger(v) && v >= LIMITES[campo].min && v <= LIMITES[campo].max;

/** Política GLOBAL da empresa (a camada de baixo do merge); valor gravado fora do limite volta ao padrão. */
async function readRetryParams(ctx, transaction) {
  const campos = Object.keys(CHAVES);
  const valores = await Promise.all(campos.map((c) => getSetting(CHAVES[c], ctx, transaction, PADROES[c])));
  return Object.fromEntries(campos.map((c, i) => [c, valido(c, valores[i]) ? valores[i] : PADROES[c]]));
}

module.exports = { PADROES, CHAVES, readRetryParams };
