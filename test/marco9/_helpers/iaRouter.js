'use strict';

// Apoio dos testes do ModelRouter (M9-D012): decisão com o sandbox, orçamento e conexões reais de teste. Banco descartável, rollback.
const { ModelRouter } = require('../../../src/features/ai/providers/ModelRouter');
const { RuleResolverRegistry } = require('../../../src/features/ai/providers/router/resolvers/ruleResolvers');
const { CachePort } = require('../../../src/features/ai/providers/router/cachePort');
const { providerRegistry, registerAiAdapters } = require('../../../src/features/ai/providers');

const tenantCtx = (tenant) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId });

/** Roteador isolado: resolvedores e cache próprios do teste, o ProviderRegistry real (com o sandbox). */
function novoRoteador({ cache, registry = providerRegistry } = {}) {
  registerAiAdapters();
  const resolvers = new RuleResolverRegistry();
  const porta = cache || new CachePort();
  return { router: new ModelRouter({ registry, resolvers, cache: porta }), resolvers, cache: porta };
}

const BASE = Object.freeze({
  agentCode: 'NAY_TESTE', criticality: 'NON_CRITICAL', inputSize: 100, requiredCapabilities: ['generate'], hasUntrustedLongDocs: false,
  latencyBudgetMs: 30000, maxOutputTokens: 512,
});
const entrada = (over = {}) => ({ ...BASE, ...over });

/** Estado de orçamento livre (NORMAL, tudo liberado) para as provas que não são sobre orçamento. */
const LIVRE = Object.freeze({ configured: true, state: 'NORMAL', allowedPaths: ['RULE', 'CACHE', 'SMALL_MODEL', 'EMBEDDING', 'ADVANCED_MODEL'] });

/** Registro que falha se alguém tentar escolher ou instanciar um modelo (prova que o caminho não chama modelo). */
const registroQueFalha = {
  candidates: async () => { throw new Error('modelo consultado'); },
  instance: async () => { throw new Error('modelo chamado'); },
};

module.exports = { registroQueFalha, tenantCtx, novoRoteador, entrada, LIVRE, BASE };
