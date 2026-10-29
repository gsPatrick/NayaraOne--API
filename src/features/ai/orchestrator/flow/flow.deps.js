'use strict';

const { ModelRouter } = require('../../providers/ModelRouter');
const { providerRegistry } = require('../../providers/ProviderRegistry');
const { getToolRegistry } = require('../../tools/bootRegistry');
const { retrieveFromIndex } = require('./flow.retrieve');

let sharedRouter = null;

/**
 * Dependências do orquestrador, todas substituíveis (testes, e as demandas que se ligam depois):
 *  - `router` (D012) e `registry` (D011, ProviderRegistry); `toolRegistry` (D016);
 *  - `retrieve({ ctx, execCtx, agent, taskType, input, purpose, runId, execution, decision, transaction })` -> fontes autorizadas; o padrão busca no
 *    índice do RAG (`RetrievalService.search`, D023) com o teto do agente em `execution`; `null` desliga a busca;
 *  - `fallbackSelector({ decision, error, attempt, ctx, transaction })` -> próxima decisão equivalente ou 503 AI_FALLBACK_UNSAFE (D013);
 *  - `clock()` em ms (prazo total do run) e `onSpan(evento)` (trilha dos 12 passos).
 */
function resolveDeps(deps = {}) {
  if (!sharedRouter) sharedRouter = new ModelRouter();
  return {
    router: deps.router || sharedRouter,
    registry: deps.registry || providerRegistry,
    toolRegistry: deps.toolRegistry || getToolRegistry(),
    retrieve: deps.retrieve === undefined ? retrieveFromIndex : deps.retrieve,
    fallbackSelector: deps.fallbackSelector || null,
    clock: deps.clock || Date.now,
    onSpan: deps.onSpan || null,
  };
}

module.exports = { resolveDeps };
