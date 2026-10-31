'use strict';

const service = require('./dry.service');
require('./dry.readiness'); // M9-D908: o GO exige a simulação de rollback executada no DRY3
require('../clock/clock.blockers'); // M9-D908: o relógio fora do limite abre blocker na Torre de controle

module.exports = { ...service, runDryRun: require('./dry.orchestrator').runDryRun };
