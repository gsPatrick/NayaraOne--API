'use strict';

const { recordError } = require('../../errors');
const { extractQuotaSafely } = require('./quota.extract');
const { recordQuota } = require('./quota.state');
const { readQuotaParams } = require('./quota.params');

const MENSAGEM_BAIXA = 'A cota do fornecedor está baixa: as operações não essenciais esperam a renovação.';

/**
 * Observa a resposta (ou o erro) de cada chamada: lê a cota que o fornecedor informou (`adapter.extractQuota`), guarda na tentativa e na
 * saúde e, abaixo da reserva (`reserve_pct`), abre o alerta MEDIUM `QUOTA_LOW` (agrupado enquanto aberto, M9-D207).
 */
async function quotaObserver({ ctx, dispatch, connection, adapter, response, error, attemptId, now, transaction }) {
  const quota = extractQuotaSafely(adapter, error || response, now);
  if (!quota) return null;
  await recordQuota(connection, attemptId, quota, now, transaction);
  const { reservePct } = await readQuotaParams(ctx, transaction);
  if (quota.limit > 0 && quota.remaining !== null && quota.remaining * 100 < quota.limit * reservePct) {
    await recordError(ctx, {
      providerCode: dispatch.providerCode, connectionId: connection.id, source: 'DISPATCH', errorClass: 'RATE_LIMIT', errorCode: 'QUOTA_LOW', severity: 'MEDIUM',
      message: MENSAGEM_BAIXA, operation: dispatch.operation, attempts: 1,
    }, transaction);
  }
  return quota;
}

module.exports = { quotaObserver, MENSAGEM_BAIXA };
