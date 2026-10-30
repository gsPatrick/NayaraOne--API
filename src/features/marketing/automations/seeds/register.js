'use strict';

const runner = require('../runner');
const { cadenceDueAt } = require('./cadence.due');
const { leaseFilter, LEASE_FILTER } = require('./locacao');
const { surveyLink } = require('./surveyLink');
const { expandPendings, EXPAND_NAME } = require('./restricao.expand');
require('./pendings.consumers'); // crm.pending.opened/resolved/cancelled alimentam a lista de pendências

/** Liga as automações prontas ao runner pelas portas dele: horário da cadência, filtro do contrato de locação e link da pesquisa de satisfação e a expansão do tick diário das pendências. */
function registerSeedPorts() {
  runner.registerCadenceDue(cadenceDueAt);
  runner.registerTriggerFilter(LEASE_FILTER, leaseFilter);
  runner.registerLinkProvider('SATISFACTION_LINK', surveyLink);
  runner.registerScheduleExpander(EXPAND_NAME, expandPendings);
}

module.exports = { registerSeedPorts };
