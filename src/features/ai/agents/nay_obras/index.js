'use strict';

// M9-D037 — pacote da NAY Obras: política, fronteira (escopo e proibições), resolvedores RULE, números e tools de leitura.
const policy = require('./obras.policy');
const { OBRAS_SETTING_DEFAULTS, OBRAS_SETTINGS_SCHEMA } = require('./obras.settings');
const { RESOLVERS } = require('./obras.resolvers');
const { registerObrasNumbers } = require('./obras.numbers');
const { constructionObras } = require('./obras.toolServices');
const TOOL_DEFINITIONS = require('./tools');
const { registerAgentScope } = require('../scope');
const { registerAgentHooks } = require('../agentHooks');
const { ruleResolvers } = require('../../providers/router/resolvers/ruleResolvers');

const KEY = {
  ALTERAR_MEDICAO: 'ia.nay_obras.proibicao.alterar_medicao',
  APROVAR_PAGAMENTO_EMPREITEIRO: 'ia.nay_obras.proibicao.aprovar_pagamento_empreiteiro',
  ALTERAR_CRONOGRAMA_ORCAMENTO: 'ia.nay_obras.proibicao.alterar_cronograma_orcamento',
  ENCERRAR_GARANTIA: 'ia.nay_obras.proibicao.encerrar_garantia',
};

function registerNayObras() {
  registerAgentScope({
    code: policy.CODE,
    outOfScopeMessage: policy.OUT_OF_SCOPE_MESSAGE,
    scopeTermsKey: 'ia.nay_obras.termos_escopo',
    scopeTermsDefault: OBRAS_SETTING_DEFAULTS['ia.nay_obras.termos_escopo'],
    prohibitions: policy.PROHIBITIONS.map((p) => ({ ...p, key: KEY[p.code], defaultTerms: OBRAS_SETTING_DEFAULTS[KEY[p.code]] })),
  });
  registerAgentHooks(policy.CODE, { readOnly: true }); // somente leitura: ação sugerida só como texto, nenhuma recomendação nem proposta
  for (const [task, resolver] of Object.entries(RESOLVERS)) ruleResolvers.register(task, resolver);
  registerObrasNumbers();
}

module.exports = { ...policy, OBRAS_SETTING_DEFAULTS, OBRAS_SETTINGS_SCHEMA, TOOL_DEFINITIONS, constructionObras, registerNayObras };
