'use strict';

const C = require('./evaluations.constants');
const E = require('./evaluations.errors');
const repo = require('./evaluations.repository');
const agentRepo = require('../agents/agents.repository');
const { resolveLimits } = require('../agents/agentLimits');
const { getToolRegistry, buildDefaultRegistry } = require('../tools');
const { loadGroundingSettings } = require('../orchestrator/grounding');
const { loadInjectionLimits } = require('../orchestrator/injectionDetector');
const { readEvaluationParams } = require('./evaluations.params');
const { resolveEvalProvider } = require('./evalProviders');
const { loadCases } = require('./cases/caseSources');
const { EVALUATORS } = require('./categoryEvaluators');
const { summarize } = require('./evaluationMetrics');
const { toEvaluation } = require('./evaluations.mapper');
const { publishEvaluationEvent, auditEvaluation } = require('./evaluations.events');
const { sha256, makeItem } = require('./categoryEvaluators/common');

async function toolRegistry() {
  try { return getToolRegistry(); } catch (e) { return buildDefaultRegistry(); }
}

const enabledToolCount = (agent) => (agent.tools || []).filter((t) => t.enabled !== false).length;

/** Orçamento de latência: o do agente (modelPolicy.latencyBudgetMs) ou, sem ele, o timeout efetivo do agente. */
async function latencyBudget(agent, ctx, transaction) {
  const own = agent.modelPolicy && agent.modelPolicy.latencyBudgetMs;
  if (Number.isInteger(own) && own > 0) return own;
  return (await resolveLimits(agent, ctx, transaction)).timeoutMs;
}

/** Roda um caso; falha inesperada do avaliador reprova o caso (não derruba a avaliação inteira). */
async function runCase(caseDef, env) {
  try {
    return await EVALUATORS[caseDef.category](caseDef, env);
  } catch (e) {
    return makeItem({ ...caseDef, input: caseDef.input || caseDef.id }, { expected: 'caso executado', actual: 'falha na execução do caso', passed: false, details: { error: String((e && e.code) || 'CASE_ERROR') } });
  }
}

async function finish(ctx, row, fields, transaction) {
  const before = toEvaluation(row);
  Object.assign(row, fields, { finishedAt: new Date() });
  await row.save({ transaction });
  const evaluation = toEvaluation(row);
  await auditEvaluation(ctx, 'ai.evaluation.finished', evaluation, before, `Avaliação da versão ${row.agentVersion} do agente ${row.agentCode}: ${row.status}.`, transaction);
  await publishEvaluationEvent(ctx, C.EVENTS.finished, evaluation, transaction);
  return evaluation;
}

/**
 * Executa uma avaliação QUEUED já travada: RUNNING, todos os casos da suíte contra o provider (sandbox por padrão), itens, métricas
 * por categoria e o estado final (PASSED = elegível; a homologação humana é outra etapa e a ativação, outra ainda). Tudo na
 * transação do chamador: se algo falhar no meio, nada fica gravado e a avaliação continua QUEUED.
 */
async function executeEvaluation(baseCtx, row, transaction) {
  const ctx = { ...baseCtx, userId: row.triggeredBy || baseCtx.userId };
  row.status = 'RUNNING';
  row.startedAt = new Date();
  await row.save({ transaction });
  const agent = await agentRepo.findOwn(ctx, row.agentCode, row.agentVersion, transaction);
  const generate = resolveEvalProvider(row.providerCode || C.SANDBOX_PROVIDER);
  if (!agent || !generate) return finish(ctx, row, { status: 'ERROR', errorCode: agent ? E.providerNotFound().code : 'AI_AGENT_NOT_FOUND' }, transaction);
  const registry = await toolRegistry();
  const params = await readEvaluationParams(ctx, transaction);
  const env = {
    agent, generate, registry, params, calls: [],
    runtime: { ctx, transaction },
    groundingSettings: await loadGroundingSettings(ctx, transaction),
    injectionLimits: await loadInjectionLimits(ctx, transaction),
  };
  const noTools = enabledToolCount(agent) === 0;
  const notApplicable = noTools ? ['TOOL_SELECTION', 'PERMISSIONS'] : [];
  const required = C.SUITE_CATEGORIES[row.suite].filter((c) => !notApplicable.includes(c));
  const cases = loadCases(row.suite, agent, registry).filter((c) => required.includes(c.category) && EVALUATORS[c.category]);
  const items = [];
  for (const c of cases) items.push(await runCase(c, env));
  for (const item of items) await repo.insertItem(ctx, row.id, item, transaction);
  const summary = summarize(items, { required, params, latencyBudgetMs: await latencyBudget(agent, ctx, transaction), calls: env.calls });
  const metrics = { ...summary.metrics, notApplicable, casesHash: sha256(cases.map((c) => c.id).sort().join('|')) };
  return finish(ctx, row, { status: summary.status, totals: summary.totals, metrics, providerCode: row.providerCode || C.SANDBOX_PROVIDER, modelCode: (env.calls[0] && env.calls[0].modelCode) || null }, transaction);
}

/** Pega e executa as avaliações QUEUED da empresa (ou a pedida), uma a uma; outra conexão pula a travada. Devolve os resultados. */
async function processQueued(ctx, transaction, { evaluationId, max = 10 } = {}) {
  const done = [];
  for (let i = 0; i < max; i += 1) {
    const row = await repo.claimQueued(ctx, i === 0 ? evaluationId : undefined, transaction);
    if (!row) break;
    done.push(await executeEvaluation(ctx, row, transaction));
    if (evaluationId) break;
  }
  return done;
}

module.exports = { executeEvaluation, processQueued };
