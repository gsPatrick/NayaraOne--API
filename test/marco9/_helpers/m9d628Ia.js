'use strict';

// Fontes de IA da M9-D628: execuções, orçamentos, chamadas de ferramenta e avaliações do agente NAY_COMERCIAL (o nome é gravado em minúsculas e sai em maiúsculas no read model).
const env628 = require('./m9d628Env');

const AGENT = 'nay_comercial';

async function ia(env, t) {
  const run = (iso, cost, grounding, path = 'SMALL_MODEL') => env628.seed(env, t, 'ai.ai_runs', {
    agent_name: AGENT, status: 'COMPLETED', routing_path: path, cost_amount: cost, cost_currency: 'BRL', grounding_status: grounding, started_at: iso, finished_at: iso, created_at: iso, updated_at: iso,
  });
  const r1 = await run('2026-10-10T12:00:00Z', '1.234567', 'GROUNDED');
  const r2 = await run('2026-10-20T12:00:00Z', '2.005000', 'INSUFFICIENT_SOURCES');
  await run('2026-10-21T12:00:00Z', '0.100000', 'NOT_APPLICABLE');
  await run('2026-09-30T12:00:00Z', '5.000000', 'GROUNDED');
  await run('2026-10-22T12:00:00Z', null, 'GROUNDED', 'RULE'); // regra sem custo: conta como execução, soma zero
  const budget = (limit, status, start, end) => env628.seed(env, t, 'ai.budgets', { agent_code: 'NAY_COMERCIAL', period: 'MONTH', limit_amount: limit, status, period_start: start, period_end: end });
  await budget('100.00', 'ACTIVE', '2026-10-01T03:00:00Z', '2026-11-01T03:00:00Z');
  await budget('999.00', 'PAUSED', '2026-09-01T03:00:00Z', '2026-10-01T03:00:00Z'); // pausado: fora (setembro segue sem orçamento)
  const call = (runId, seq, status, iso) => env628.seed(env, t, 'ai.tool_calls', {
    run_id: runId, seq, tool_name: 'crm.list', args_hash: 'b'.repeat(64), idempotency_key: `m9d628-${env628.uuid()}`, status, started_at: iso, created_at: iso, updated_at: iso,
    tool_version: '1', permission_code: 'crm:read', risk_level: 'LOW', ...(status === 'BLOCKED' ? { blocked_reason: 'PERMISSION' } : {}),
  });
  await call(r1, 1, 'SUCCEEDED', '2026-10-10T12:00:01Z');
  await call(r1, 2, 'BLOCKED', '2026-10-10T12:00:02Z');
  await call(r2, 1, 'SUCCEEDED', '2026-10-20T12:00:01Z');
  const evaluation = await env628.seed(env, t, 'ai.evaluations', { agent_code: 'NAY_COMERCIAL', agent_version: 1, suite: 'GOLDEN', status: 'PASSED', finished_at: '2026-10-22T12:00:00Z', created_at: '2026-10-22T11:00:00Z', updated_at: '2026-10-22T12:00:00Z' });
  for (const [i, score] of ['1', '0.5', '0.25'].entries()) {
    await env628.seed(env, t, 'ai.evaluation_items', { evaluation_id: evaluation, case_id: `c${i}`, category: 'GROUNDING', input_hash: 'c'.repeat(64), passed: true, score, created_at: '2026-10-22T12:00:00Z' });
  }
  return { r1, r2, evaluation };
}

module.exports = { ia };
