'use strict';

// M9-D034 (e livro do Marco 3 §12/§16/§18, rodada M3CB) — pacote da NAY Comercial: política, fronteira (escopo e proibições de escrita), resolvedores RULE das três capacidades do
// piloto e dos dois rascunhos, recomendação NEXT_ACTION, trava de gravação das propostas e a tool de proposta fora da allowlist.
const policy = require('./comercial.policy');
const { COMERCIAL_KEYS: K, COMERCIAL_SETTING_DEFAULTS, COMERCIAL_SETTINGS_SCHEMA } = require('./comercial.settings');
const { RESOLVERS } = require('./comercial.resolvers');
const { CAPABILITY_RESOLVERS } = require('./comercial.capabilities');
const { reviewComercialAnswer } = require('./comercial.review');
const { comercialServerSources } = require('./comercial.sources');
const { recommendNextAction } = require('./comercial.recommend');
const { registerComercialGates } = require('./comercial.gates');
const { registerComercialSettingGuard } = require('./comercial.settingGuard');
const { proposalsAllowed } = require('./comercial.params');
const { registerAgentScope } = require('../scope');
const { registerAgentHooks } = require('../agentHooks');
const { ruleResolvers } = require('../../providers/router/resolvers/ruleResolvers');

const KEY = {
  CRIAR_TAREFA: K.forbidCreateTask, ALTERAR_ETAPA: K.forbidChangeStage, ENVIAR_MENSAGEM: K.forbidSendMessage, PUBLICAR_DESCRICAO: K.forbidPublish,
  INFERIR_ATRIBUTO_SENSIVEL: K.forbidInferSensitive,
};

function registerNayComercial() {
  registerAgentScope({
    code: policy.CODE,
    outOfScopeMessage: policy.OUT_OF_SCOPE_MESSAGE,
    scopeTermsKey: K.scopeTerms,
    scopeTermsDefault: COMERCIAL_SETTING_DEFAULTS[K.scopeTerms],
    prohibitions: policy.PROHIBITIONS.map((p) => ({
      ...p,
      key: KEY[p.code],
      defaultTerms: COMERCIAL_SETTING_DEFAULTS[KEY[p.code]],
      // Com as propostas liberadas, "criar tarefa" deixa de ser recusa e vira PROPOSTA de aprovação humana (D019).
      ...(p.code === 'CRIAR_TAREFA' ? { enabled: async (env) => !(await proposalsAllowed(env.tenant, env.transaction)) } : {}),
    })),
  });
  // Livro do Marco 3 §12/§16: fontes do servidor para a redação por modelo, revisão da saída antes do aterramento (guarda da descrição e
  // de atributo sensível) e a recomendação de cada capacidade.
  registerAgentHooks(policy.CODE, { checkAnswer: recommendNextAction, reviewAnswer: reviewComercialAnswer, serverSources: comercialServerSources });
  for (const [task, resolver] of Object.entries({ ...RESOLVERS, ...CAPABILITY_RESOLVERS })) ruleResolvers.register(task, resolver);
  registerComercialGates();
  registerComercialSettingGuard();
}

module.exports = { ...policy, COMERCIAL_SETTING_DEFAULTS, COMERCIAL_SETTINGS_SCHEMA, registerNayComercial };
