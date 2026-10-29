'use strict';

/** Health check ativo (Marco 9, M9-D223): teste de saúde de uma connection e rodada da empresa. */
const { runConnectionHealthCheck } = require('./healthCheckRun');
const { runHealthCheckCycle } = require('./healthCheckCycle');

module.exports = { runConnectionHealthCheck, runHealthCheckCycle };
