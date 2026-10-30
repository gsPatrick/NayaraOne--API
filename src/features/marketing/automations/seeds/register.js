'use strict';

const runner = require('../runner');
const { cadenceDueAt } = require('./cadence.due');
const { leaseFilter, LEASE_FILTER } = require('./locacao');
const { surveyLink } = require('./surveyLink');

/** Liga as automações prontas ao runner pelas portas dele: horário da cadência, filtro do contrato de locação e link da pesquisa de satisfação. */
function registerSeedPorts() {
  runner.registerCadenceDue(cadenceDueAt);
  runner.registerTriggerFilter(LEASE_FILTER, leaseFilter);
  runner.registerLinkProvider('SATISFACTION_LINK', surveyLink);
}

module.exports = { registerSeedPorts };
