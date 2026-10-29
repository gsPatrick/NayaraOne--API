'use strict';

const { ModelRouter } = require('../../providers/ModelRouter');
const { providerRegistry } = require('../../providers/ProviderRegistry');
const { createFallbackSelector } = require('../../providers/fallback');
const { getToolRegistry } = require('../../tools/bootRegistry');
const { retrieveFromIndex } = require('./flow.retrieve');

let sharedRouter = null;

/**
 * Dependências do orquestrador, todas substituíveis (testes, e as demandas que se ligam depois):
 *  - `router` (D012) e `registry` (D011, ProviderRegistry); `toolRegistry` (D016);
 *  - `retrieve({ ctx, execCtx, agent, taskType, input, purpose, runId, execution, decision, transaction })` -> fontes autorizadas; o padrão busca no
 *    índice do RAG (`RetrievalService.search`, D023) com o teto do agente em `execution`; `null` desliga a busca;
 *  - `aiAccess` (guarda de campos da IA, M9-D915): sem ele o ContextBuilder da D027 não monta contexto e nenhuma memória entra no run;
 *  - `fallbackSelector({ decision, error, attempt, ctx, transaction, input, usage })` -> próxima decisão equivalente ou 503 AI_FALLBACK_UNSAFE (D013);
 *    o padrão é o seletor de equivalência segura de providers/fallback;
 *  - `openTransaction(fn)` (M9-D030): abre o run numa transação própria, confirmada na hora, para o run longo (resposta 202) já ser visível a
 *    quem o consulta; sem ele o run nasce na transação do chamador;
 *  - `clock()` em ms (prazo total do run) e `onSpan(evento)` (trilha dos 12 passos).
 */
function resolveDeps(deps = {}) {
  if (!sharedRouter) sharedRouter = new ModelRouter();
  return {
    router: deps.router || sharedRouter,
    registry: deps.registry || providerRegistry,
    toolRegistry: deps.toolRegistry || getToolRegistry(),
    retrieve: deps.retrieve === undefined ? retrieveFromIndex : deps.retrieve,
    fallbackSelector: deps.fallbackSelector || createFallbackSelector({ registry: deps.registry || providerRegistry }),
    aiAccess: deps.aiAccess || null,
    openTransaction: deps.openTransaction || null,
    clock: deps.clock || Date.now,
    onSpan: deps.onSpan || null,
  };
}

module.exports = { resolveDeps };
