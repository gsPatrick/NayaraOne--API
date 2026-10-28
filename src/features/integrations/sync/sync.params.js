'use strict';

const { getSetting } = require('../../settings/settings.service');

/** Leitura dos parâmetros da sincronização, com o padrão do parametros.csv quando a empresa não configurou. */
const PADROES = Object.freeze({
  pageSize: 200, leaseS: 300, overlapS: 60, failuresToStall: 5,
  stalledAfterMinutes: Object.freeze({ CRITICAL: 15, HIGH: 30, MEDIUM: 120, LOW: 1440 }),
});

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

async function readSyncParams(ctx, transaction) {
  const lidos = await Promise.all([
    getSetting('integration.sync.page_size', ctx, transaction, PADROES.pageSize),
    getSetting('integration.sync.lease_s', ctx, transaction, PADROES.leaseS),
    getSetting('integration.sync.overlap_s', ctx, transaction, PADROES.overlapS),
    getSetting('integration.sync.failures_to_stall', ctx, transaction, PADROES.failuresToStall),
    ...Object.keys(PADROES.stalledAfterMinutes).map((c) => getSetting(`integration.sync.stalled_after_minutes.${c}`, ctx, transaction, PADROES.stalledAfterMinutes[c])),
  ]);
  const [pageSize, leaseS, overlapS, failuresToStall, ...limites] = lidos;
  const stalledAfterMinutes = {};
  Object.keys(PADROES.stalledAfterMinutes).forEach((c, i) => { stalledAfterMinutes[c] = inteiro(limites[i], PADROES.stalledAfterMinutes[c], 1); });
  return {
    pageSize: inteiro(pageSize, PADROES.pageSize, 1),
    leaseS: inteiro(leaseS, PADROES.leaseS, 1),
    overlapS: inteiro(overlapS, PADROES.overlapS, 0),
    failuresToStall: inteiro(failuresToStall, PADROES.failuresToStall, 1),
    stalledAfterMinutes,
  };
}

module.exports = { PADROES, readSyncParams };
