'use strict';

const { ModelRouter } = require('../../providers/ModelRouter');
const { providerRegistry } = require('../../providers/ProviderRegistry');
const { getToolRegistry } = require('../../tools/bootRegistry');

let sharedRouter = null;

/**
 * Dependências do orquestrador, todas substituíveis (testes, e as demandas que se ligam depois):
 *  - `router` (D012) e `registry` (D011, ProviderRegistry); `toolRegistry` (D016);
 *  - `retrieve({ ctx, execCtx, agent, taskType, input, purpose, transaction })` -> fontes autorizadas (D023/D024);
 *  - `fallbackSelector({ decision, error, attempt, ctx, transaction })` -> próxima decisão equivalente ou 503 AI_FALLBACK_UNSAFE (D013);
 *  - `clock()` em ms (prazo total do run) e `onSpan(evento)` (trilha dos 12 passos).
 */
function resolveDeps(deps = {}) {
  if (!sharedRouter) sharedRouter = new ModelRouter();
  return {
    router: deps.router || sharedRouter,
    registry: deps.registry || providerRegistry,
    toolRegistry: deps.toolRegistry || getToolRegistry(),
    retrieve: deps.retrieve || null,
    fallbackSelector: deps.fallbackSelector || null,
    clock: deps.clock || Date.now,
    onSpan: deps.onSpan || null,
  };
}

module.exports = { resolveDeps };
