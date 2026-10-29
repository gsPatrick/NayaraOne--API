'use strict';

// M9-D035 — pacote da NAY Diretoria: cadastro (política), fronteira (escopo e proibições), resolvedores RULE e extratores de números.
const policy = require('./diretoria.policy');
const { DIRETORIA_KEYS: K, DIRETORIA_SETTING_DEFAULTS, DIRETORIA_SETTINGS_SCHEMA } = require('./diretoria.settings');
const { RESOLVERS } = require('./diretoria.resolvers');
const { CASES } = require('./diretoria.golden');
const { registerDiretoriaNumbers } = require('./diretoria.numbers');
const { areaLabelDecorator } = require('./diretoria.decorate');
const { registerAgentScope, wireScopeGuard } = require('../scope');
const { registerAgentHooks } = require('../agentHooks');
const { ruleResolvers } = require('../../providers/router/resolvers/ruleResolvers');

const KEY = Object.freeze({ EXECUTAR_OU_PROPOR_ACAO: K.forbidAction, DETALHE_NOMINAL: K.forbidDetail, NUMERO_SEM_FONTE: K.forbidUnsourced });

function registerNayDiretoria() {
  registerAgentScope({
    code: policy.CODE,
    outOfScopeMessage: policy.OUT_OF_SCOPE_MESSAGE,
    scopeTermsKey: K.scopeTerms,
    scopeTermsDefault: DIRETORIA_SETTING_DEFAULTS[K.scopeTerms],
    prohibitions: policy.PROHIBITIONS.map((p) => ({ ...p, key: KEY[p.code], defaultTerms: DIRETORIA_SETTING_DEFAULTS[KEY[p.code]] })),
    decorate: areaLabelDecorator,
  });
  wireScopeGuard();
  registerAgentHooks(policy.CODE, { readOnly: true }); // somente leitura: nenhuma recomendação nem proposta nasce deste agente
  for (const [task, resolver] of Object.entries(RESOLVERS)) ruleResolvers.register(task, resolver);
  registerDiretoriaNumbers();
}

module.exports = { ...policy, GOLDEN_CASES: CASES, RULE_TASKS: RESOLVERS, DIRETORIA_SETTING_DEFAULTS, DIRETORIA_SETTINGS_SCHEMA, registerNayDiretoria };
