'use strict';

const { resolveEffectivePolicy } = require('../retry/retry.policy');
const { acquireLocalToken } = require('./quota.limiter');
const { readValidQuota } = require('./quota.state');
const { readQuotaParams } = require('./quota.params');

/** Passa à frente quando a cota está escassa: operação essencial ou perigosa (M9-D218 3.2); mensagem em massa e sincronização esperam. */
const isPriority = (dispatch) => dispatch.essential === true || dispatch.criticalityOp === 'DANGEROUS';

/**
 * Decide, SEM gastar tentativa, se o envio pode sair agora (M9-D218 3.2 e 3.4):
 *  1. cota do fornecedor: sem saldo (`remaining` = 0) ou abaixo da reserva (`reserve_pct` do limite), só prioritário passa; o resto
 *     espera a renovação (`quota_resets_at`; sem ela, `fallback_wait_s`);
 *  2. limite local da política (`rate_limit.per_second|per_minute|per_day`): sem vaga, espera o instante do próximo token.
 * Devolve { until, reason } para esperar ou null para seguir.
 */
async function quotaPreflight({ ctx, dispatch, connection, now, transaction }) {
  const params = await readQuotaParams(ctx, transaction);
  if (!isPriority(dispatch)) {
    const q = await readValidQuota(connection.id, now, params.fallbackWaitS, transaction);
    if (q && q.remaining !== null) {
      const escasso = q.remaining <= 0 || (q.limit > 0 && q.remaining * 100 < q.limit * params.reservePct);
      if (escasso) return { until: q.resetsAt || new Date(now.getTime() + params.fallbackWaitS * 1000), reason: q.remaining <= 0 ? 'QUOTA_EXHAUSTED' : 'QUOTA_RESERVED' };
    }
  }
  const policy = await resolveEffectivePolicy(ctx, connection, transaction);
  const token = await acquireLocalToken(connection.id, policy.rate_limit, now, transaction);
  return token.granted ? null : { until: token.until, reason: 'LOCAL_RATE_LIMIT' };
}

module.exports = { quotaPreflight, isPriority };
