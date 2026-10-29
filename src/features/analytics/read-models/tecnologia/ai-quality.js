'use strict';

/**
 * M9-D628 — rm_ai_quality: por agente e semana (segunda-feira de São Paulo), as execuções (`runs`), as com fundamentação aplicável (`grounding_runs`: tudo que não é
 * NOT_APPLICABLE) e a soma da pontuação de fundamentação (`grounding_score_sum`: execução GROUNDED vale 1, as demais valem 0), mais os itens das avaliações encerradas na
 * semana (`eval_items`) e a soma dos seus scores (`eval_score_sum`, ai.evaluation_items.score de 0 a 1). Guardar somas e contagens (e não a média) deixa o KPI calcular a média
 * exata e sem arredondar antes. Nenhum prompt, resposta nem conteúdo de caso: só contagens e pontuações.
 */
const { select, defineCompanyWideModel, toRow } = require('./common');
const { AI_QUALITY_EVENTS } = require('./events');

const KEY = ['agent', 'week'];
const WEEK = (column) => `to_char(date_trunc('week', ${column} AT TIME ZONE :tz)::date, 'YYYY-MM-DD')`;

async function build({ companyId, now, window, transaction }) {
  const records = await select(
    `WITH r AS (
       SELECT upper(COALESCE(NULLIF(btrim(agent_name), ''), 'SEM_AGENTE')) AS agent, ${WEEK('started_at')} AS week, count(*)::int AS runs,
              (count(*) FILTER (WHERE grounding_status <> 'NOT_APPLICABLE'))::int AS grounding_runs, (count(*) FILTER (WHERE grounding_status = 'GROUNDED'))::numeric AS grounding_score_sum
         FROM ai.ai_runs WHERE company_id = :companyId AND started_at <= CAST(:now AS timestamptz) AND (started_at AT TIME ZONE :tz)::date >= CAST(:from AS date) GROUP BY 1, 2),
     e AS (
       SELECT upper(v.agent_code) AS agent, ${WEEK('v.finished_at')} AS week, count(i.id)::int AS eval_items, COALESCE(sum(i.score), 0) AS eval_score_sum
         FROM ai.evaluations v JOIN ai.evaluation_items i ON i.evaluation_id = v.id AND i.company_id = v.company_id
        WHERE v.company_id = :companyId AND v.finished_at IS NOT NULL AND v.finished_at <= CAST(:now AS timestamptz) AND (v.finished_at AT TIME ZONE :tz)::date >= CAST(:from AS date) GROUP BY 1, 2)
     SELECT COALESCE(r.agent, e.agent) AS agent, COALESCE(r.week, e.week)::date AS week, COALESCE(r.runs, 0) AS runs, COALESCE(r.grounding_runs, 0) AS grounding_runs,
            COALESCE(r.grounding_score_sum, 0) AS grounding_score_sum, COALESCE(e.eval_items, 0) AS eval_items, COALESCE(e.eval_score_sum, 0) AS eval_score_sum
       FROM r FULL JOIN e ON e.agent = r.agent AND e.week = r.week ORDER BY 1, 2`,
    { companyId, now, from: window.from }, transaction
  );
  return records.map((r) => toRow(KEY)({ ...r, week: String(r.week instanceof Date ? r.week.toISOString().slice(0, 10) : r.week).slice(0, 10) }));
}

const def = defineCompanyWideModel({ name: 'rm_ai_quality', keyColumns: KEY, events: AI_QUALITY_EVENTS, build });

module.exports = { def, build };
