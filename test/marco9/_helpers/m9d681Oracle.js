'use strict';

// Oráculo da M9-D681: recalcula cada KPI de IA SÓ com as linhas-fonte (ai.ai_runs, ai.budgets, ai.tool_calls, ai.evaluation_items) por consulta independente ao banco, sem passar pelos
// read models nem pelas fórmulas. Números em texto decimal, como o KPI. A conta de percentual é feita em inteiros (BigInt), meio para cima.
const TZ = 'America/Sao_Paulo';
const one = async (env, sql, replacements) => (await env.admin.query(sql, { replacements: { tz: TZ, ...replacements } }))[0][0];

/** num / den x 100 com 2 casas, meio para cima, só com inteiros. */
function pct(num, den) {
  const n = BigInt(num); const d = BigInt(den);
  if (d === 0n) return null;
  const scaled = (n * 20000n + d) / (2n * d);
  return `${scaled / 100n}.${String(scaled % 100n).padStart(2, '0')}`;
}

/** Custo do mês de SP das execuções concluídas (em centavos inteiros, depois de somar exato) e quantas são. */
async function cost(env, t, month, agent = null) {
  const r = await one(env, `SELECT round(COALESCE(sum(cost_amount), 0), 2)::text AS total, count(*)::int AS runs, count(*) FILTER (WHERE cost_amount IS NULL AND routing_path IN ('SMALL_MODEL', 'ADVANCED_MODEL'))::int AS "noCost"
      FROM ai.ai_runs WHERE company_id = :c AND status = 'COMPLETED' AND to_char(started_at AT TIME ZONE :tz, 'YYYY-MM') = :m ${agent ? 'AND upper(agent_name) = :a' : ''}`, { c: t.companyId, m: month, a: agent });
  return r;
}

async function budget(env, t, month, agent) {
  const r = await one(env, "SELECT COALESCE(sum(limit_amount), 0)::text AS total FROM ai.budgets WHERE company_id = :c AND status = 'ACTIVE' AND agent_code = :a AND to_char(period_start AT TIME ZONE :tz, 'YYYY-MM') = :m", { c: t.companyId, m: month, a: agent });
  return r.total;
}

/** Fundamentação da semana (segunda a domingo de SP): execuções com fundamentação aplicável, as GROUNDED e a % de fundamentadas. */
async function grounding(env, t, weekStart) {
  const r = await one(env, `SELECT count(*) FILTER (WHERE grounding_status <> 'NOT_APPLICABLE')::int AS applicable, count(*) FILTER (WHERE grounding_status = 'GROUNDED')::int AS grounded, count(*)::int AS runs
      FROM ai.ai_runs WHERE company_id = :c AND (started_at AT TIME ZONE :tz)::date >= CAST(:w AS date) AND (started_at AT TIME ZONE :tz)::date < CAST(:w AS date) + 7`, { c: t.companyId, w: weekStart });
  return { ...r, value: pct(r.grounded, r.applicable), blocked: r.applicable - r.grounded };
}

/** Chamadas de ferramenta do mês de SP até o dia-base: total, bloqueadas (BLOCKED, e só ela), por motivo. */
async function toolCalls(env, t, month, asOf) {
  const r = await one(env, `SELECT count(*)::int AS calls, count(*) FILTER (WHERE tc.status = 'BLOCKED')::int AS blocked
      FROM ai.tool_calls tc WHERE tc.company_id = :c AND to_char(tc.started_at AT TIME ZONE :tz, 'YYYY-MM') = :m AND (tc.started_at AT TIME ZONE :tz)::date <= CAST(:d AS date)`, { c: t.companyId, m: month, d: asOf });
  const reasons = (await env.admin.query(`SELECT blocked_reason AS reason, count(*)::int AS n FROM ai.tool_calls WHERE company_id = :c AND status = 'BLOCKED' AND to_char(started_at AT TIME ZONE :tz, 'YYYY-MM') = :m
      AND (started_at AT TIME ZONE :tz)::date <= CAST(:d AS date) GROUP BY 1 ORDER BY 1`, { replacements: { tz: TZ, c: t.companyId, m: month, d: asOf } }))[0];
  return { ...r, value: pct(r.blocked, r.calls), reasons: Object.fromEntries(reasons.map((x) => [x.reason, x.n])) };
}

module.exports = { pct, cost, budget, grounding, toolCalls };
