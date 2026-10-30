'use strict';

const runner = require('../runner');
const { registerSeed } = require('./install');
const { RADAR_ACTIVE_FILTER, radarActiveFilter, radarBroker, matchVariables, radarLink } = require('./radarPorts');
const { radarDefinition, RADAR_CODE } = require('./radarFlow');

/** Liga a automação do Radar (M9-D421) ao runner pelas portas dele e a registra entre as automações prontas. */
function registerRadarSeed() {
  runner.registerTriggerFilter(RADAR_ACTIVE_FILTER, radarActiveFilter);
  runner.registerAssigneeResolver('RADAR_BROKER', radarBroker);
  runner.registerVariablesProvider('RADAR_MATCH', matchVariables);
  runner.registerLinkProvider('RADAR_LINK', radarLink);
  registerSeed(RADAR_CODE, radarDefinition);
}

module.exports = { registerRadarSeed };
