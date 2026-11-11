'use strict';

const { readRetryParams } = require('../../../integrations/dispatch/retry/retry.params');
const { backoffMs } = require('../../../integrations/dispatch/retry/retry.delay');
const { readReconcileParams, waitBeforeAttemptS } = require('../../../integrations/dispatch/reconcile/reconcile.params');

/**
 * Política de nova tentativa da entrega de campanha. Não é regra nova: o plano de contingência do canal (M9-D430) manda o e-mail para a "nova tentativa
 * por classe de erro" do bloco de Integrações, então valem os MESMOS parâmetros que o administrador já edita em Configurações > Integrações:
 *  - falha transitória (INT-006, §8 TRANSIENT/RATE_LIMIT): `integration.retry.*` de M9-D216 (base, fator, teto, jitter, tentativas, espera máxima atendida
 *    no 429 e adiamentos seguidos por limite que ainda não contam como tentativa);
 *  - resultado incerto (INT-005, §7 e §8 UNKNOWN "tentativas limitadas + DLQ"): `integration.unknown.*` de M9-D215 (consultas e esperas entre elas).
 * Lidos na hora, por empresa (DI-M9E-1). `rand` injetável nos testes (jitter).
 */
async function readDeliveryPolicy(tenant, transaction) {
  const [retry, reconcile] = await Promise.all([readRetryParams(tenant, transaction), readReconcileParams(tenant, transaction)]);
  return { retry, reconcile };
}

const addMs = (date, ms) => new Date(date.getTime() + ms);

/**
 * Próximo passo de uma falha transitória. `row` = linha atual (ou null na primeira tentativa); `failure` = { rateLimited, retryAfterMs }.
 * Limite do fornecedor (429) não gasta tentativa enquanto os adiamentos seguidos ficarem abaixo de `rate_limit_max_deferrals`; a espera é a maior entre o
 * backoff e o Retry-After (este limitado a `rate_limit_max_wait_s`). Devolve { exhausted, attempts, rateDeferrals, nextAttemptAt, waitMs }.
 */
function planRetry(row, failure, policy, now, rand = Math.random) {
  const { retry } = policy;
  const prevAttempts = row ? Number(row.attempts) : 0;
  const prevDeferrals = row ? Number(row.rate_deferrals) : 0;
  const deferral = Boolean(failure.rateLimited) && prevDeferrals < retry.rate_limit_max_deferrals;
  const attempts = deferral ? Math.max(prevAttempts, 1) : prevAttempts + 1;
  const rateDeferrals = failure.rateLimited ? prevDeferrals + 1 : 0;
  if (!deferral && attempts >= retry.max_attempts) return { exhausted: true, attempts, rateDeferrals };
  const afterMs = Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs > 0 ? Math.min(failure.retryAfterMs, retry.rate_limit_max_wait_s * 1000) : 0;
  const waitMs = Math.max(backoffMs(attempts, retry, rand), afterMs);
  return { exhausted: false, attempts, rateDeferrals, nextAttemptAt: addMs(now, waitMs), waitMs };
}

/** Próxima consulta do UNKNOWN: `done` consultas já feitas sem resposta conclusiva. Esgotou -> { exhausted: true } (fila morta). */
function planReconcile(done, policy, now) {
  if (done >= policy.reconcile.maxAttempts) return { exhausted: true, reconcileAttempts: done };
  return { exhausted: false, reconcileAttempts: done, nextAttemptAt: addMs(now, waitBeforeAttemptS(policy.reconcile, done) * 1000) };
}

module.exports = { readDeliveryPolicy, planRetry, planReconcile };
