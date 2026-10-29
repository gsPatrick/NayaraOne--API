'use strict';

const { getSetting } = require('../../../settings/settings.service');

/** Padrões do livro (M9-D214 3.2: a cada 2 s, lote 20); a espera por conexão parada é a decisão DI-D214-3. */
const PADROES = Object.freeze({ intervalS: 2, batchSize: 20, blockedRecheckS: 60 });

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

async function readWorkerParams(ctx, transaction) {
  const [intervalo, lote, recheck] = await Promise.all([
    getSetting('integration.dispatch.worker_interval_s', ctx, transaction, PADROES.intervalS),
    getSetting('integration.dispatch.worker_batch_size', ctx, transaction, PADROES.batchSize),
    getSetting('integration.dispatch.blocked_recheck_s', ctx, transaction, PADROES.blockedRecheckS),
  ]);
  return {
    intervalS: inteiro(intervalo, PADROES.intervalS, 1),
    batchSize: inteiro(lote, PADROES.batchSize, 1),
    blockedRecheckS: inteiro(recheck, PADROES.blockedRecheckS, 5),
  };
}

module.exports = { PADROES, readWorkerParams };
