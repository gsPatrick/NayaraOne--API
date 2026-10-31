'use strict';

const service = require('./dry.service');
const readinessHook = require('./dry.readiness');
const clockBlockers = require('../clock/clock.blockers');

/** Registro explícito dos ganchos da M9-D908 (idempotente): o GO exige a simulação de rollback do DRY3 e o relógio fora do limite abre blocker na Torre de controle. */
function install() {
  readinessHook.install();
  clockBlockers.install();
}

module.exports = { ...service, runDryRun: require('./dry.orchestrator').runDryRun, install };
