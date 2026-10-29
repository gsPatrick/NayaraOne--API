'use strict';

const { CODE, DEFINITION } = require('./definition');
const { SCOPE_DEFINITION, checkAnswer } = require('./boundary');
const { RULE_TASKS } = require('./rules');
const { CASES } = require('./golden');
const { CORRESPONDENTE_SETTING_DEFAULTS, CORRESPONDENTE_SETTINGS_SCHEMA } = require('./correspondente.settings');
const { registerAgentScope, wireScopeGuard } = require('../scope');
const { registerAgentHooks } = require('../agentHooks');
const { ruleResolvers } = require('../../providers/router/resolvers/ruleResolvers');

/**
 * NAY Correspondente (M9-D039): pendências, simulações e status do financiamento, somente leitura e sem decisão de crédito. Registra
 * a fronteira (recusa de pedido fora do propósito e das cinco proibições), os resolvedores de regra e o gancho de resposta
 * (`readOnly`: nenhuma recomendação nem proposta nasce deste agente). Idempotente.
 */
function registerNayCorrespondente() {
  registerAgentScope(SCOPE_DEFINITION);
  wireScopeGuard();
  registerAgentHooks(CODE, { readOnly: true, checkAnswer });
  for (const [taskType, resolver] of Object.entries(RULE_TASKS)) ruleResolvers.register(taskType, resolver);
}

module.exports = {
  CODE, DEFINITION, GOLDEN_CASES: CASES, RULE_TASKS, CORRESPONDENTE_SETTING_DEFAULTS, CORRESPONDENTE_SETTINGS_SCHEMA, registerNayCorrespondente,
};
