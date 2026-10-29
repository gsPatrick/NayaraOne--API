'use strict';

const { getSetting } = require('../../../settings/settings.service');

/** Padrões do parametros.csv (livro: M9-D212 e M9-D213), usados quando a empresa não configurou. */
const PADROES = Object.freeze({
  responseTimeoutMs: 2000,
  workerIntervalS: 5,
  workerBatchSize: 50,
  timestampToleranceS: 300,
  replayWindowS: 86400,
  maxJsonDepth: 20,
  maxKeys: 5000,
  maxStringLength: 100000,
  acceptedContentTypes: 'application/json,text/plain',
  providerBodyCeilingBytes: 10485760,
});

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

/** Parâmetros da borda e do worker, da empresa dona do canal (ou da empresa da sessão, no worker). */
async function readIntakeParams(tenant, transaction) {
  const [timeout, interval, batch, tol, replay, depth, keys, str, types] = await Promise.all([
    getSetting('integration.webhook.response_timeout_ms', tenant, transaction, PADROES.responseTimeoutMs),
    getSetting('integration.webhook.worker_interval_s', tenant, transaction, PADROES.workerIntervalS),
    getSetting('integration.webhook.worker_batch_size', tenant, transaction, PADROES.workerBatchSize),
    getSetting('integration.webhook.timestamp_tolerance_s', tenant, transaction, PADROES.timestampToleranceS),
    getSetting('integration.webhook.replay_window_s', tenant, transaction, PADROES.replayWindowS),
    getSetting('integration.webhook.max_json_depth', tenant, transaction, PADROES.maxJsonDepth),
    getSetting('integration.webhook.max_keys', tenant, transaction, PADROES.maxKeys),
    getSetting('integration.webhook.max_string_length', tenant, transaction, PADROES.maxStringLength),
    getSetting('integration.webhook.accepted_content_types', tenant, transaction, PADROES.acceptedContentTypes),
  ]);
  return {
    responseTimeoutMs: inteiro(timeout, PADROES.responseTimeoutMs, 100),
    workerIntervalS: inteiro(interval, PADROES.workerIntervalS, 1),
    workerBatchSize: inteiro(batch, PADROES.workerBatchSize, 1),
    timestampToleranceS: inteiro(tol, PADROES.timestampToleranceS, 1),
    replayWindowS: inteiro(replay, PADROES.replayWindowS, 60),
    maxJsonDepth: inteiro(depth, PADROES.maxJsonDepth, 1),
    maxKeys: inteiro(keys, PADROES.maxKeys, 1),
    maxStringLength: inteiro(str, PADROES.maxStringLength, 100),
    acceptedContentTypes: String(typeof types === 'string' ? types : PADROES.acceptedContentTypes).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
  };
}

module.exports = { PADROES, readIntakeParams };
