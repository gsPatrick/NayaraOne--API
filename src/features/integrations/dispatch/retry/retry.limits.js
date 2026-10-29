'use strict';

const AppError = require('../../../../utils/AppError');
const { circuitProblems } = require('../../health/circuitPolicy');

/**
 * Limites da política de envio (M9-D216 seção 6): impedem configuração destrutiva (zero tentativas, atraso de anos, jitter que
 * inverte o sinal). Valem para o parâmetro da empresa, para `providers.default_policy_json` e para `connections.policy_json`.
 * `retry` guarda os números da nova tentativa; `rate_limit` o limite local de chamadas (M9-D218).
 */
const RETRY_LIMITS = Object.freeze({
  base_delay_ms: { min: 100, max: 3600000 },
  factor: { min: 1, max: 10 },
  cap_delay_ms: { min: 1000, max: 86400000 },
  max_attempts: { min: 1, max: 20 },
  jitter_pct: { min: 0, max: 50 },
  rate_limit_max_wait_s: { min: 1, max: 86400 },
});
const RATE_LIMIT_LIMITS = Object.freeze({
  per_second: { min: 1, max: 10000 },
  per_minute: { min: 1, max: 1000000 },
  per_day: { min: 1, max: 100000000 },
});

const invalid = (problemas) => AppError.unprocessable('A política da integração tem valores fora dos limites permitidos.', 'INTEGRATION_POLICY_INVALID', { problemas });

function checkSection(section, name, limits, problemas) {
  if (section === undefined) return;
  if (section === null || typeof section !== 'object' || Array.isArray(section)) { problemas.push(`${name}: esperado um objeto`); return; }
  for (const [key, value] of Object.entries(section)) {
    const lim = limits[key];
    if (!lim) { problemas.push(`${name}.${key}: campo desconhecido`); continue; }
    if (!Number.isInteger(value) || value < lim.min || value > lim.max) problemas.push(`${name}.${key}: use um inteiro de ${lim.min} a ${lim.max}`);
  }
}

/** Valida as seções `retry`, `rate_limit` e `circuit` de uma política (as demais chaves, como egressHosts, são de outras demandas). 422 INTEGRATION_POLICY_INVALID. */
function validatePolicyJson(policy) {
  if (policy === undefined || policy === null) return;
  if (typeof policy !== 'object' || Array.isArray(policy)) throw invalid(['política: esperado um objeto']);
  const problemas = [];
  checkSection(policy.retry, 'retry', RETRY_LIMITS, problemas);
  checkSection(policy.rate_limit, 'rate_limit', RATE_LIMIT_LIMITS, problemas);
  problemas.push(...circuitProblems(policy.circuit)); // M9-D217: limiar, cooldown e chamadas de teste do circuito
  const r = policy.retry;
  if (r && Number.isInteger(r.base_delay_ms) && Number.isInteger(r.cap_delay_ms) && r.cap_delay_ms < r.base_delay_ms) problemas.push('retry.cap_delay_ms: não pode ser menor que base_delay_ms');
  if (problemas.length) throw invalid(problemas);
}

module.exports = { RETRY_LIMITS, RATE_LIMIT_LIMITS, validatePolicyJson };
