'use strict';

const budgets = require('../../budgets');
const { estimateTokens } = require('./flow.input');

const DEFAULT_MAX_OUTPUT = 1024;
const CLASS_ORDER = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];

/** Maior classificação entre as fontes (a política do provedor é decidida por ela). Sem fonte, INTERNAL. */
function highestClassification(sources) {
  return (sources || []).reduce((top, s) => (CLASS_ORDER.indexOf(s.classification) > CLASS_ORDER.indexOf(top) ? s.classification : top), 'INTERNAL');
}

/** Entrada do roteador (D012) a partir do estado do run: tipo da tarefa, criticidade da versão do agente, tamanho, capacidades, latência e orçamento. */
async function routerInput(state, { inputSize, skipShortCircuit = false } = {}) {
  const { agent, ctx, parsed, guard, transaction } = state;
  const hasTools = (agent.tools || []).some((t) => t.enabled);
  const policy = agent.modelPolicy || {};
  return {
    agentCode: agent.code,
    agentVersion: agent.version,
    cacheableTaskTypes: Array.isArray(policy.cacheableTaskTypes) ? policy.cacheableTaskTypes : [],
    taskType: parsed.taskType,
    criticality: agent.criticality,
    inputSize: inputSize === undefined ? estimateTokens(parsed.input) : inputSize,
    requiredCapabilities: [...new Set(['generate', ...(hasTools ? ['toolUse'] : []), ...parsed.requiredCapabilities])],
    hasUntrustedLongDocs: state.sources.some((s) => s.longDocument === true),
    latencyBudgetMs: Number.isFinite(policy.latencyBudgetMs) ? policy.latencyBudgetMs : guard.limits.timeoutMs,
    maxOutputTokens: Number.isInteger(policy.maxOutputTokens) ? policy.maxOutputTokens : DEFAULT_MAX_OUTPUT,
    politica: { classification: highestClassification(state.sources) },
    budgetState: await budgets.budgetState(ctx, { agentCode: agent.code, criticality: agent.criticality, at: new Date(state.clock()) }, transaction),
    ruleInput: { taskType: parsed.taskType, input: parsed.input, purpose: parsed.purpose, agentCode: agent.code, userId: ctx.userId, permissions: ctx.permissions || [] },
    cacheKey: state.requestHash,
    skipShortCircuit,
  };
}

/** Passo 3: o caminho da tarefa (regra, cache, pequeno ou avançado) com orçamento e latência. Erros: 429/403 do orçamento, 503 sem modelo. */
async function resolveRoute(state) {
  state.routerInput = await routerInput(state);
  state.decision = await state.deps.router.decide(state.routerInput, state.ctx, state.transaction);
  state.routingPath = state.decision.path;
  return state.decision;
}

/** Passo 6 (primeira volta): reescolhe o modelo com o tamanho real do prompt montado (as fontes só são conhecidas depois do passo 3). */
async function refineRoute(state, promptTokens) {
  state.routerInput = await routerInput(state, { inputSize: promptTokens, skipShortCircuit: true });
  const before = state.decision;
  state.decision = await state.deps.router.decide(state.routerInput, state.ctx, state.transaction);
  state.routingPath = state.decision.path;
  return { before, after: state.decision };
}

module.exports = { resolveRoute, refineRoute, routerInput, highestClassification };
