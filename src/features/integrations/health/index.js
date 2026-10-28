'use strict';

/** Saúde dos fornecedores (Marco 9, M9-D206): integration.provider_health. */
const { aggregateConnectionHealth, runCompanyAggregation } = require('./aggregateRunner');
const { readCircuitState, updateCircuitState, clearCircuitCache } = require('./circuitState');
const { recordHealthCheck } = require('./healthRecorder');
const { getCurrentHealth } = require('./healthQuery');
const { purgeExpiredHealth } = require('./healthRetention');
const { registerHealthSampleSource, resetHealthSampleSources } = require('./sampleSources');
const { readHealthParams } = require('./healthParams');

module.exports = {
  aggregateConnectionHealth,
  runCompanyAggregation,
  readCircuitState,
  updateCircuitState,
  clearCircuitCache,
  recordHealthCheck,
  getCurrentHealth,
  purgeExpiredHealth,
  registerHealthSampleSource,
  resetHealthSampleSources,
  readHealthParams,
};
