'use strict';

/**
 * M9-D628 — rm_ai_tool_calls: por agente e dia de São Paulo, as chamadas de ferramenta da NAY (`calls`, ai.tool_calls ligadas à execução do agente) e as BLOQUEADAS (`blocked`,
 * status BLOCKED: política, permissão, orçamento, allowlist, schema, STALE...). Proposta aguardando aprovação (PROPOSED) e rejeição humana (CANCELLED_BY_HUMAN) contam nas chamadas e NÃO
 * como bloqueio (M9-D681). `by_tool` guarda chamadas e bloqueadas por ferramenta e `by_reason` as bloqueadas por motivo (blocked_reason; vazio vira NO_REASON). Nenhum argumento,
 * resultado ou conteúdo: só contagens.
 */
const { select, defineCompanyWideModel, toRow } = require('./common');
const { AI_TOOL_EVENTS } = require('./events');

const KEY = ['agent', 'day'];

async function build({ companyId, now, window, transaction }) {
  const records = await select(
    `WITH t AS (
       SELECT upper(COALESCE(NULLIF(btrim(r.agent_name), ''), 'SEM_AGENTE')) AS agent, to_char((c.started_at AT TIME ZONE :tz)::date, 'YYYY-MM-DD') AS day, c.tool_name AS tool,
              (c.status = 'BLOCKED') AS is_blocked, CASE WHEN c.status = 'BLOCKED' THEN COALESCE(NULLIF(btrim(c.blocked_reason), ''), 'NO_REASON') END AS reason, count(*)::int AS n
         FROM ai.tool_calls c JOIN ai.ai_runs r ON r.id = c.run_id AND r.company_id = c.company_id
        WHERE c.company_id = :companyId AND c.started_at <= CAST(:now AS timestamptz) AND (c.started_at AT TIME ZONE :tz)::date BETWEEN CAST(:from AS date) AND CAST(:today AS date)
        GROUP BY 1, 2, 3, 4, 5),
     tool AS (SELECT agent, day, tool, sum(n)::int AS calls, (COALESCE(sum(n) FILTER (WHERE is_blocked), 0))::int AS blocked FROM t GROUP BY 1, 2, 3),
     by_tool AS (SELECT agent, day, sum(calls)::int AS calls, sum(blocked)::int AS blocked, jsonb_object_agg(tool, jsonb_build_object('calls', calls, 'blocked', blocked)) AS by_tool FROM tool GROUP BY 1, 2),
     by_reason AS (SELECT agent, day, jsonb_object_agg(reason, n) AS by_reason FROM (SELECT agent, day, reason, sum(n)::int AS n FROM t WHERE is_blocked GROUP BY 1, 2, 3) x GROUP BY 1, 2)
     SELECT a.agent, a.day, a.calls, a.blocked, a.by_tool, COALESCE(b.by_reason, '{}'::jsonb) AS by_reason FROM by_tool a LEFT JOIN by_reason b ON b.agent = a.agent AND b.day = a.day ORDER BY 1, 2`,
    { companyId, now, from: window.from, today: window.today }, transaction
  );
  return records.map(toRow(KEY));
}

const def = defineCompanyWideModel({ name: 'rm_ai_tool_calls', keyColumns: KEY, events: AI_TOOL_EVENTS, build });

module.exports = { def, build };
