'use strict';

/** Saúde dos fornecedores (Marco 9, M9-D206): integration.provider_health. */
const { aggregateConnectionHealth, runCompanyAggregation } = require('./aggregateRunner');
const { readCircuitState, updateCircuitState, clearCircuitCache } = require('./circuitState');
const { recordHealthCheck } = require('./healthRecorder');
const { getCurrentHealth } = require('./healthQuery');
const { purgeExpiredHealth } = require('./healthRetention');
const { registerHealthSampleSource, resetHealthSampleSources } = require('./sampleSources');
const { readHealthParams } = require('./healthParams');
const { admitCall, recordCallResult, assertCallAllowed } = require('./circuitBreaker');
const { resolveCircuitPolicy } = require('./circuitPolicyReader');
const { runConnectionHealthCheck, runHealthCheckCycle } = require('./healthCheck');
const { assessProductionReadiness, registerReadinessCheck, clearReadinessChecks } = require('./productionReadiness');
const { RUNBOOK_SECTIONS, runbookPathFor, validateRunbook, assertRunbook } = require('./runbooks');

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
  admitCall,
  recordCallResult,
  assertCallAllowed,
  resolveCircuitPolicy,
  runConnectionHealthCheck,
  runHealthCheckCycle,
  assessProductionReadiness,
  registerReadinessCheck,
  clearReadinessChecks,
  RUNBOOK_SECTIONS,
  runbookPathFor,
  validateRunbook,
  assertRunbook,
};
