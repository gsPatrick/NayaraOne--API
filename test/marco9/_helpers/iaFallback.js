'use strict';

// Apoio dos testes do fallback seguro (M9-D013): linhas de modelo com garantias diferentes, um registro falso (entradas, candidatos e adapters
// derivados do sandbox, sem rede) e o orquestrador com o roteador sobre esse registro. Os adapters respondem como o provider sandbox.
const { SANDBOX_MODELS } = require('../../../src/features/ai/providers/sandbox/sandboxModels');
const { SandboxAdapter } = require('../../../src/features/ai/providers/sandbox/SandboxAdapter');
const { AiProviderError } = require('../../../src/features/ai/providers');
const { rankCandidates } = require('../../../src/features/ai/providers/candidates');
const { readProviderParams } = require('../../../src/features/ai/providers/providers.params');
const { ModelRouter } = require('../../../src/features/ai/providers/ModelRouter');
const { RuleResolverRegistry } = require('../../../src/features/ai/providers/router/resolvers/ruleResolvers');
const { CachePort } = require('../../../src/features/ai/providers/router/cachePort');

const BASE = SANDBOX_MODELS[0];

/** Linha do catálogo: `modelo` muda o modelo (tier, retenção, região, structuredOutput...), `politica` muda a política do provedor. */
function linha(providerCode, modelo = {}, politica = {}) {
  return {
    providerCode,
    policy: { labOnly: false, ...politica },
    model: { ...BASE, model: `${providerCode}-m`, dataRetention: 'NONE', region: 'BR', safetyTier: 3, ...modelo },
    capabilities: ['generate'],
  };
}

/** A decisão do roteador cujo modelo escolhido é `origem` e cuja cadeia de fallback são as `cadeia` (nessa ordem). */
function decisao(origem, cadeia = []) {
  const link = (l) => ({ provider: l.providerCode, model: l.model.model, classe: l.model.classe, estimatedCost: '0.000100' });
  return { path: 'SMALL_MODEL', ...link(origem), reason: 'SMALL_TASK', fallbackChain: cadeia.map(link), escalated: false };
}

/** Registro falso: `falham` = { codigoDoProvedor: 'UNAVAILABLE' | ... } faz o adapter daquele provedor falhar sempre. `chamadas` guarda cada geração pedida. */
function registroFalso(linhas, { falham = {} } = {}) {
  const chamadas = [];
  const sandbox = new SandboxAdapter(null);
  return {
    chamadas,
    async entries() { return linhas; },
    async candidates(query, tenant, transaction) {
      const params = await readProviderParams(tenant, transaction);
      return rankCandidates(linhas, { ...query, capabilities: query.requiredCapabilities || [] }, params);
    },
    has(code) { return linhas.some((l) => l.providerCode === code); },
    async instance(code) {
      return {
        async generate(request) {
          chamadas.push({ code, model: request.model });
          if (falham[code]) throw new AiProviderError(falham[code], { providerCode: code });
          return sandbox.generate({ ...request, model: BASE.model });
        },
      };
    },
  };
}

/** Roteador sobre o registro dado (sem regra e sem cache): a escolha do modelo é só pelos candidatos. */
const roteadorSobre = (registry) => new ModelRouter({ registry, resolvers: new RuleResolverRegistry(), cache: new CachePort() });

/** `deps` do orquestrador para um registro falso (roteador e registro), com o seletor padrão do fallback seguro. */
const depsDoRegistro = (registry, extra = {}) => ({ registry, router: roteadorSobre(registry), ...extra });

module.exports = { linha, decisao, registroFalso, roteadorSobre, depsDoRegistro, BASE };
