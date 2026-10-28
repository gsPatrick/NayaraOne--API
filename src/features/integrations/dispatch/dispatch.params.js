'use strict';

const { getSetting } = require('../../settings/settings.service');

/** Padrões do parametros.csv, usados quando a empresa não configurou. */
const PADROES = Object.freeze({ sendingStaleS: 120, retentionDays: 365, payloadRetentionDays: 90, maxAttempts: 8 });

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

async function readDispatchParams(ctx, transaction) {
  const [stale, ret, payload, max] = await Promise.all([
    getSetting('integration.dispatch.sending_stale_s', ctx, transaction, PADROES.sendingStaleS),
    getSetting('integration.dispatch.retention_days', ctx, transaction, PADROES.retentionDays),
    getSetting('integration.dispatch.payload_retention_days', ctx, transaction, PADROES.payloadRetentionDays),
    getSetting('integration.retry.max_attempts', ctx, transaction, PADROES.maxAttempts),
  ]);
  return {
    sendingStaleS: inteiro(stale, PADROES.sendingStaleS, 10),
    retentionDays: inteiro(ret, PADROES.retentionDays, 1),
    payloadRetentionDays: inteiro(payload, PADROES.payloadRetentionDays, 1),
    maxAttempts: inteiro(max, PADROES.maxAttempts, 1),
  };
}

module.exports = { PADROES, readDispatchParams };
