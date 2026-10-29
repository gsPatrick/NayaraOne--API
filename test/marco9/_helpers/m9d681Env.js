'use strict';

// Apoio dos testes dos KPIs de IA no BI (M9-D681): ai.cost_by_agent, ai.quality_scores, ai.budget e ai.tool_calls_blocked.
// Duas empresas novas (contagens independentes), relógio fixo (12:00 de 28/10/2026 em São Paulo) e as fontes da IA (execuções, orçamentos, chamadas de ferramenta e avaliações).
const { createKit } = require('./biKpiKit');
const env628 = require('./m9d628Env');
const kpisApi = require('../../../src/features/analytics/metrics/kpis');

const CODES = ['ai.cost_by_agent', 'ai.quality_scores', 'ai.budget', 'ai.tool_calls_blocked'];
const SEP = '2026-09-20'; // dia 20 de 30: a conta do livro (640,00 de 900,00 => projeção 960,00)

const kit = createKit({
  models: env628.MODELS, label: 'D681',
  materialize: async (t, asOf, tx) => ({ ia: await kpisApi.materializeIaKpis({ companyId: t.companyId, groupId: t.groupId }, asOf, tx) }),
});

const AGENT_C = 'nay_comercial'; // gravado em minúsculas, sai em maiúsculas nos read models
const AGENT_F = 'nay_financeiro';

/** Execução de IA. `cost` nulo = sem custo gravado. */
function runOf(env, t, agent, iso, cost, { model = 'm-small', grounding = 'NOT_APPLICABLE', path = 'SMALL_MODEL', status = 'COMPLETED' } = {}) {
  return env628.seed(env, t, 'ai.ai_runs', {
    agent_name: agent, status, routing_path: path, model_code: model, cost_amount: cost, cost_currency: 'BRL', grounding_status: grounding,
    started_at: iso, finished_at: iso, created_at: iso, updated_at: iso,
  });
}

const budget = (env, t, agent, limit, start, end) => env628.seed(env, t, 'ai.budgets', { agent_code: agent, period: 'MONTH', limit_amount: limit, status: 'ACTIVE', period_start: start, period_end: end });

function call(env, t, runId, seq, tool, status, iso, reason = null) {
  return env628.seed(env, t, 'ai.tool_calls', {
    run_id: runId, seq, tool_name: tool, args_hash: 'b'.repeat(64), idempotency_key: `m9d681-${env628.uuid()}`, status, started_at: iso, created_at: iso, updated_at: iso,
    tool_version: '1', permission_code: 'crm:read', risk_level: 'LOW', ...(reason ? { blocked_reason: reason } : {}),
  });
}

/**
 * Cenário: outubro/2026 (NAY_COMERCIAL 8 execuções de 80,00 = 640,00 e orçamento de 900,00; NAY_FINANCEIRO 10,00 + 5,50 e orçamento de 20,00), a semana de 26/10 (6 de 8 com fonte
 * em NAY_COMERCIAL), 13 chamadas de ferramenta com 3 bloqueadas (PERMISSION, STALE, ALLOWLIST) mais uma PROPOSED e uma CANCELLED_BY_HUMAN que não contam, e setembro (640,00 de 900,00;
 * uma execução às 23:30 de 30/09 em São Paulo, que já é 01/10 em UTC).
 */
async function seedAi(env, t) {
  const comercial = [];
  for (const [i, iso] of ['2026-10-26T12:00:00Z', '2026-10-26T13:00:00Z', '2026-10-26T14:00:00Z', '2026-10-27T12:00:00Z', '2026-10-27T13:00:00Z', '2026-10-27T14:00:00Z', '2026-10-28T12:00:00Z', '2026-10-28T13:00:00Z'].entries()) {
    const grounding = i < 6 ? 'GROUNDED' : i === 6 ? 'INSUFFICIENT_SOURCES' : 'CONFLICTING_SOURCES';
    comercial.push(await runOf(env, t, AGENT_C, iso, '80.000000', { grounding }));
  }
  await runOf(env, t, AGENT_F, '2026-10-27T15:00:00Z', '10.000000', { model: 'm-large', grounding: 'GROUNDED', path: 'ADVANCED_MODEL' });
  await runOf(env, t, AGENT_F, '2026-10-27T16:00:00Z', '5.500000', { model: 'm-large', grounding: 'GROUNDED', path: 'ADVANCED_MODEL' });
  await runOf(env, t, AGENT_C, '2026-10-20T12:00:00Z', '3.000000', { status: 'FAILED' }); // falhou: não entra no custo
  for (const iso of ['2026-09-29T12:00:00Z', '2026-09-29T13:00:00Z', '2026-09-29T14:00:00Z', '2026-09-29T15:00:00Z', '2026-09-29T16:00:00Z']) await runOf(env, t, AGENT_C, iso, '120.000000', { grounding: 'GROUNDED' });
  await runOf(env, t, AGENT_C, '2026-10-01T02:30:00Z', '40.000000', { grounding: 'INSUFFICIENT_SOURCES' }); // 23:30 de 30/09 em São Paulo
  await budget(env, t, 'NAY_COMERCIAL', '900.00', '2026-10-01T03:00:00Z', '2026-11-01T03:00:00Z');
  await budget(env, t, 'NAY_FINANCEIRO', '20.00', '2026-10-01T03:00:00Z', '2026-11-01T03:00:00Z');
  await budget(env, t, 'NAY_COMERCIAL', '900.00', '2026-09-01T03:00:00Z', '2026-10-01T03:00:00Z');
  const first = comercial[0];
  const second = comercial[3];
  for (let seq = 1; seq <= 7; seq += 1) await call(env, t, first, seq, 'crm.list', 'SUCCEEDED', `2026-10-26T12:00:0${seq}Z`);
  await call(env, t, first, 8, 'crm.list', 'BLOCKED', '2026-10-26T12:00:09Z', 'PERMISSION');
  await call(env, t, second, 1, 'finance.get', 'SUCCEEDED', '2026-10-27T12:00:01Z');
  await call(env, t, second, 2, 'finance.get', 'BLOCKED', '2026-10-27T12:00:02Z', 'STALE');
  await call(env, t, second, 3, 'finance.get', 'BLOCKED', '2026-10-27T12:00:03Z', 'ALLOWLIST');
  await call(env, t, second, 4, 'finance.get', 'PROPOSED', '2026-10-27T12:00:04Z');
  await call(env, t, second, 5, 'finance.get', 'CANCELLED_BY_HUMAN', '2026-10-27T12:00:05Z');
  await call(env, t, comercial[7], 1, 'crm.list', 'BLOCKED', '2026-10-01T02:30:00Z', 'PERMISSION'); // 23:30 de 30/09 em São Paulo: setembro
  const evaluation = await env628.seed(env, t, 'ai.evaluations', { agent_code: 'NAY_COMERCIAL', agent_version: 1, suite: 'GOLDEN', status: 'PASSED', finished_at: '2026-10-27T12:00:00Z', created_at: '2026-10-27T11:00:00Z', updated_at: '2026-10-27T12:00:00Z' });
  for (const [i, score] of ['1', '0.5', '0.25'].entries()) {
    await env628.seed(env, t, 'ai.evaluation_items', { evaluation_id: evaluation, case_id: `c${i}`, category: 'GROUNDING', input_hash: 'c'.repeat(64), passed: true, score, created_at: '2026-10-27T12:00:00Z' });
  }
  return { comercial };
}

module.exports = { ...env628, ...kit, CODES, SEP, AGENT_C, AGENT_F, seedAi, runOf, budget, call, MODELS: env628.MODELS };
