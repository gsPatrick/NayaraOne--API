'use strict';

// Espião do provider nos testes do orquestrador: embrulha o ProviderRegistry e registra cada pedido de geração (system, mensagens,
// modelo) sem mudar a resposta do sandbox.
const { providerRegistry } = require('../../../src/features/ai/providers');

const { AiProviderError } = require('../../../src/features/ai/providers');

/** `falharNa`: número da chamada de geração (1, 2...) que falha como o fornecedor falharia (`kind`: UNAVAILABLE, TIMEOUT...). */
function espiaRegistry({ falharNa = null, kind = 'UNAVAILABLE' } = {}) {
  const pedidos = [];
  const registry = {
    async instance(code, tenant, tx) {
      const real = await providerRegistry.instance(code, tenant, tx);
      return new Proxy(real, {
        get(alvo, prop) {
          if (prop !== 'generate') { const v = alvo[prop]; return typeof v === 'function' ? v.bind(alvo) : v; }
          return async (request) => {
            pedidos.push({ code, ...request });
            if (falharNa === pedidos.length) throw new AiProviderError(kind, { providerCode: code });
            return alvo.generate(request);
          };
        },
      });
    },
  };
  return { registry, pedidos };
}

module.exports = { espiaRegistry };
