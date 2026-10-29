'use strict';

/**
 * M9-D628 — rm_ai_tool_calls: por agente e dia de São Paulo, as chamadas de ferramenta da NAY (`calls`, ai.tool_calls ligadas à execução do agente) e as BLOQUEADAS (`blocked`,
 * status BLOCKED: política, permissão, orçamento ou aprovação humana). Nenhum argumento, resultado ou conteúdo: só contagens.
 */
const { select, defineCompanyWideModel, toRow } = require('./common');
const { AI_TOOL_EVENTS } = require('./events');

const KEY = ['agent', 'day'];

async function build({ companyId, now, window, transaction }) {
  const records = await select(
    `SELECT upper(COALESCE(NULLIF(btrim(r.agent_name), ''), 'SEM_AGENTE')) AS agent, to_char((t.started_at AT TIME ZONE :tz)::date, 'YYYY-MM-DD') AS day,
            count(*)::int AS calls, (count(*) FILTER (WHERE t.status = 'BLOCKED'))::int AS blocked
       FROM ai.tool_calls t JOIN ai.ai_runs r ON r.id = t.run_id AND r.company_id = t.company_id
      WHERE t.company_id = :companyId AND t.started_at <= CAST(:now AS timestamptz) AND (t.started_at AT TIME ZONE :tz)::date BETWEEN CAST(:from AS date) AND CAST(:today AS date)
      GROUP BY 1, 2 ORDER BY 1, 2`,
    { companyId, now, from: window.from, today: window.today }, transaction
  );
  return records.map(toRow(KEY));
}

const def = defineCompanyWideModel({ name: 'rm_ai_tool_calls', keyColumns: KEY, events: AI_TOOL_EVENTS, build });

module.exports = { def, build };
