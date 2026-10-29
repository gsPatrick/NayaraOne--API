'use strict';

/** Limite e cota do fornecedor (Marco 9, M9-D218). Ao carregar, registra a verificação de cota e o observador de resposta no worker. */
const { registerPreflight, registerCallObserver } = require('../worker/worker.hooks');
const { quotaPreflight, isPriority } = require('./quota.preflight');
const { quotaObserver } = require('./quota.observer');
const { acquireLocalToken } = require('./quota.limiter');
const { extractQuotaFromHeaders, extractQuotaSafely } = require('./quota.extract');
const { readValidQuota, recordQuota } = require('./quota.state');
const { readQuotaParams, PADROES } = require('./quota.params');
const { dispatchHealthSample, registerDispatchHealthSource } = require('./quota.sample');
const { quotaExhausted } = require('./quota.errors');
const { assertQuotaAvailable } = require('./quota.assert');

registerPreflight(quotaPreflight);
registerCallObserver(quotaObserver);

module.exports = {
  quotaPreflight, quotaObserver, isPriority, acquireLocalToken, extractQuotaFromHeaders, extractQuotaSafely, readValidQuota, recordQuota, readQuotaParams,
  QUOTA_PADROES: PADROES, dispatchHealthSample, registerDispatchHealthSource, quotaExhausted, assertQuotaAvailable,
};
