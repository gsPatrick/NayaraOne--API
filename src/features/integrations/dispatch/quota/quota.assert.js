'use strict';

const { quotaPreflight } = require('./quota.preflight');
const { quotaExhausted } = require('./quota.errors');

/**
 * Para operação SEM fila (quem chama espera a resposta): se o envio não poderia sair agora por cota ou limite local, recusa com 429
 * INTEGRATION_QUOTA_EXHAUSTED e o instante em que volta. Operação com fila nunca falha por isso: o worker apenas a reagenda.
 */
async function assertQuotaAvailable({ ctx, dispatch, connection, now = new Date(), transaction }) {
  const verdict = await quotaPreflight({ ctx, dispatch, connection, now, transaction });
  if (verdict) throw quotaExhausted(verdict.until);
  return true;
}

module.exports = { assertQuotaAvailable };
