'use strict';

const runner = require('../runner');
const { registerSeed } = require('./install');
const { LEAD_ORIGIN_FILTER, leadOriginFilter, originChannel, optedInChannel, nameVariables, followUpVariables, opportunityOwner } = require('./leadPorts');
const { coldVariables } = require('./leadContent');
const { expandSemRetorno, expandClienteFrio, EXPAND_SEM_RETORNO, EXPAND_CLIENTE_FRIO } = require('./leadExpand');
const { leadNovoDefinition, semRetornoDefinition, clienteFrioDefinition, LEAD_NOVO_CODE, SEM_RETORNO_CODE, CLIENTE_FRIO_CODE } = require('./leadFlows');

/** Liga as automações de entrada do funil (M9-D420) ao runner pelas portas dele e as registra entre as automações prontas. */
function registerLeadSeeds() {
  runner.registerTriggerFilter(LEAD_ORIGIN_FILTER, leadOriginFilter);
  runner.registerChannelResolver('ORIGIN', originChannel);
  runner.registerChannelResolver('OPTED_IN', optedInChannel);
  runner.registerVariablesProvider('PERSON', nameVariables);
  runner.registerVariablesProvider('SEM_RETORNO', followUpVariables);
  runner.registerVariablesProvider('CLIENTE_FRIO', coldVariables);
  runner.registerAssigneeResolver('OPPORTUNITY_OWNER', opportunityOwner);
  runner.registerScheduleExpander(EXPAND_SEM_RETORNO, expandSemRetorno);
  runner.registerScheduleExpander(EXPAND_CLIENTE_FRIO, expandClienteFrio);
  registerSeed(LEAD_NOVO_CODE, leadNovoDefinition);
  registerSeed(SEM_RETORNO_CODE, semRetornoDefinition);
  registerSeed(CLIENTE_FRIO_CODE, clienteFrioDefinition);
}

module.exports = { registerLeadSeeds };
