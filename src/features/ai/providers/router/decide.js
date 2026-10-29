'use strict';

const budgetErrors = require('../../budgets/budgets.errors');
const { forcedRoutingPath } = require('../../orchestrator/numbers/calculationRoute');
const { readRouterParams } = require('./router.params');
const { classOfTask, REASONS } = require('./router.tasks');
const E = require('./router.errors');

const CLASS_BY_PATH = Object.freeze({ SMALL_MODEL: 'SMALL', ADVANCED_MODEL: 'ADVANCED' });
const DEFAULT_MAX_OUTPUT = 1024;

const tenantOf = (ctx) => ({ groupId: ctx.groupId, companyId: ctx.companyId });

/** Falha fechada pelo orçamento: o caminho escolhido não está liberado pela política (M9-D014). */
function assertBudgetAllows(path, budgetState) {
  if (!budgetState) return;
  if (!budgetState.configured && budgetState.configured !== undefined) throw budgetErrors.notConfigured();
  if (Array.isArray(budgetState.allowedPaths) && !budgetState.allowedPaths.includes(path)) {
    throw budgetState.state === 'DEGRADED' ? budgetErrors.degraded({ state: budgetState.state, routingPath: path }) : budgetErrors.exhausted({ state: budgetState.state, routingPath: path });
  }
}

/** Candidatos elegíveis da classe pedida, já em ordem de custo e latência (a lista vem do ProviderRegistry, D011). */
async function eligibleOf(path, input, params, ctx, transaction, registry) {
  const lista = await registry.candidates({
    requiredCapabilities: input.requiredCapabilities && input.requiredCapabilities.length ? input.requiredCapabilities : ['generate'],
    criticidade: input.criticality,
    politica: input.politica || {},
    requestSize: { tokensIn: Number.isFinite(input.inputSize) ? input.inputSize : 0, tokensOut: input.maxOutputTokens || DEFAULT_MAX_OUTPUT },
    latencyBudgetMs: input.latencyBudgetMs,
  }, tenantOf(ctx), transaction);
  return lista.filter((c) => c.classe === CLASS_BY_PATH[path]);
}

const link = (c) => ({ provider: c.providerCode, model: c.model, classe: c.classe, estimatedCost: c.estimatedCost });

/** Monta a decisão de modelo: o primeiro candidato é o escolhido e os demais ficam na cadeia (a equivalência segura é da D013). */
function modelDecision(path, reason, lista, extra = {}) {
  const [first, ...rest] = lista;
  return {
    path, provider: first.providerCode, model: first.model, classe: first.classe, reason, estimatedCost: first.estimatedCost,
    fallbackChain: rest.map(link), escalated: false, ...extra,
  };
}

/**
 * Decisão do roteador (M9-D012). Ordem, a primeira que se aplica vence: (1) regra/código; (2) cache seguro; (3) modelo pequeno;
 * (4) modelo avançado. Orçamento e latência entram na decisão: caminho fora da política do orçamento é 429 (ou 403 sem
 * orçamento) e candidato mais lento que `latencyBudgetMs` sai da lista. Sem candidato elegível: 503 AI_NO_ELIGIBLE_MODEL.
 * Função determinística: a mesma entrada, o mesmo registro e o mesmo estado dão sempre a mesma decisão.
 */
async function decide(input, ctx, transaction, { registry, resolvers, cache }) {
  if (!input || typeof input.taskType !== 'string' || !input.taskType.trim()) throw E.invalidInput('Informe o tipo da tarefa (taskType).');
  const params = await readRouterParams(ctx, transaction);
  const resolver = resolvers.get(input.taskType);
  const forced = forcedRoutingPath(input.taskType);
  if (resolver) {
    const result = await resolver(input.ruleInput === undefined ? input : input.ruleInput, { tenant: tenantOf(ctx), transaction });
    if (result !== null && result !== undefined) {
      return { path: 'RULE', provider: null, model: null, reason: REASONS.RULE_RESOLVER, fallbackChain: [], escalated: false, ruleResult: result };
    }
  }
  if (forced === 'RULE') return { path: 'RULE', provider: null, model: null, reason: REASONS.RULE_FORCED, fallbackChain: [], escalated: false, ruleResult: null };

  const hit = await cache.lookup(input, { tenant: tenantOf(ctx), transaction });
  if (hit) return { path: 'CACHE', provider: null, model: null, reason: REASONS.CACHE_HIT, fallbackChain: [], escalated: false, cacheResult: hit.result, cacheKey: hit.key || null };

  const wanted = classOfTask(input, params);
  assertBudgetAllows(wanted.path, input.budgetState);
  const lista = await eligibleOf(wanted.path, input, params, ctx, transaction, registry);
  if (!lista.length) throw E.noEligibleModel({ routingPath: wanted.path, taskType: input.taskType });
  return modelDecision(wanted.path, wanted.reason, lista);
}

module.exports = { decide, eligibleOf, modelDecision, assertBudgetAllows, tenantOf };
