'use strict';

const { providerRegistry } = require('./ProviderRegistry');
const { ruleResolvers } = require('./router/resolvers/ruleResolvers');
const { cachePort } = require('./router/cachePort');
const { decide } = require('./router/decide');
const { escalate } = require('./router/escalate');

/**
 * ModelRouter (M9-D012) — para cada tarefa, o caminho mais barato que resolve com segurança: regra/código (custo zero), cache seguro,
 * modelo pequeno, modelo avançado só quando necessário, com orçamento (M9-D014) e latência na decisão. Os candidatos vêm do
 * ProviderRegistry (M9-D011); o roteador não monta lista própria nem conhece fornecedor. `decide` registra no run o caminho
 * (`routing_path`), o provedor, o modelo, o motivo e a cadeia de fallback (a escolha do fallback seguro é da M9-D013).
 */
class ModelRouter {
  constructor({ registry = providerRegistry, resolvers = ruleResolvers, cache = cachePort } = {}) {
    this.nome = 'ModelRouter';
    this.deps = { registry, resolvers, cache };
  }

  decide(input, ctx, transaction) { return decide(input, ctx, transaction, this.deps); }

  escalate(decision, outcome, input, ctx, transaction) { return escalate(decision, outcome, input, ctx, transaction, this.deps); }
}

module.exports = { ModelRouter };
