'use strict';

const { ModelRouter } = require('../../providers/ModelRouter');
const { providerRegistry } = require('../../providers/ProviderRegistry');
const { createFallbackSelector } = require('../../providers/fallback');
const { getToolRegistry } = require('../../tools/bootRegistry');
const cache = require('../../budgets/cache.service');
const { retrieveFromIndex } = require('./flow.retrieve');

let sharedRouter = null;

const productionAiAccess = () => require('../../../core-governance/data-quality/aiAccess.guard');

/**
 * Dependências do orquestrador, todas substituíveis (testes, e as demandas que se ligam depois):
 *  - `router` (D012) e `registry` (D011, ProviderRegistry); `toolRegistry` (D016);
 *  - `retrieve({ ctx, execCtx, agent, taskType, input, purpose, runId, execution, decision, transaction })` -> fontes autorizadas; o padrão busca no
 *    índice do RAG (`RetrievalService.search`, D023) com o teto do agente em `execution`; `null` desliga a busca;
 *  - `aiAccess` (guarda de campos da IA, M9-D915; o padrão é o guarda real de core-governance, `null` o desliga): sem ele o ContextBuilder da D027 não monta contexto e nenhuma memória entra no run;
 *  - `fallbackSelector({ decision, error, attempt, ctx, transaction, input, usage })` -> próxima decisão equivalente ou 503 AI_FALLBACK_UNSAFE (D013);
 *    o padrão é o seletor de equivalência segura de providers/fallback;
 *  - `cacheStore(ctx, dados, transaction)` guarda o resultado elegível do run no cache seguro (D015); `null` desliga a gravação;
 *  - `clock()` em ms (prazo total do run) e `onSpan(evento)` (trilha dos 12 passos).
 */
function resolveDeps(deps = {}) {
  if (!sharedRouter) sharedRouter = new ModelRouter();
  return {
    router: deps.router || sharedRouter,
    registry: deps.registry || providerRegistry,
    toolRegistry: deps.toolRegistry || getToolRegistry(),
    retrieve: deps.retrieve === undefined ? retrieveFromIndex : deps.retrieve,
    cacheStore: deps.cacheStore === undefined ? cache.store : deps.cacheStore,
    fallbackSelector: deps.fallbackSelector || createFallbackSelector({ registry: deps.registry || providerRegistry }),
    // Sem `aiAccess` informado vale o guarda real da governança (M9-D915); `aiAccess: null` desliga (o ContextBuilder então não monta contexto).
    aiAccess: deps.aiAccess === undefined ? productionAiAccess() : deps.aiAccess,
    clock: deps.clock || Date.now,
    onSpan: deps.onSpan || null,
  };
}

module.exports = { resolveDeps };
