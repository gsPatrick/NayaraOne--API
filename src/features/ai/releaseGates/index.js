'use strict';

const { registerReleaseGateRoutes } = require('./releaseGates.routes');
const { registerReleaseGateGuard, assertProductionGate, assertAgentEnableAllowed } = require('./releaseGates.guard');
const service = require('./releaseGates.service');

// Portão de liberação para produção (M9-D046): carregar este índice registra a trava de `ia.ambiente`.
registerReleaseGateGuard();

module.exports = { registerReleaseGateRoutes, assertProductionGate, assertAgentEnableAllowed, ...service };
