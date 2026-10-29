'use strict';

/**
 * M9-D628 — rm_ai_cost: por agente da NAY (código em maiúsculas) e mês de São Paulo, o custo em reais com 2 casas das execuções (ai.ai_runs.cost_amount, moeda BRL, arredondado UMA
 * vez na soma), a quantidade de execuções e o orçamento mensal ativo do agente (soma de ai.budgets ACTIVE com o agente e o início do período naquele mês; nulo = sem orçamento).
 * Execução em outra moeda não entra no custo em reais. A janela cobre os meses inteiros dos últimos analytics.tec.historico_dias dias. Nenhum prompt, resposta nem argumento: só custo e contagem.
 */
const { select, defineCompanyWideModel, toRow, monthStart } = require('./common');
const { AI_COST_EVENTS } = require('./events');

const KEY = ['agent', 'month'];
const MONTH = (column) => `to_char(${column} AT TIME ZONE :tz, 'YYYY-MM')`;

async function build({ companyId, now, window, transaction }) {
  const records = await select(
    `WITH r AS (
       SELECT upper(COALESCE(NULLIF(btrim(agent_name), ''), 'SEM_AGENTE')) AS agent, ${MONTH('started_at')} AS month, COALESCE(cost_amount, 0) AS cost
         FROM ai.ai_runs WHERE company_id = :companyId AND cost_currency = 'BRL' AND started_at <= CAST(:now AS timestamptz) AND (started_at AT TIME ZONE :tz)::date >= CAST(:from AS date)),
     c AS (SELECT agent, month, round(sum(cost), 2) AS cost_brl, count(*)::int AS runs FROM r GROUP BY 1, 2),
     b AS (SELECT agent_code AS agent, ${MONTH('period_start')} AS month, sum(limit_amount) AS budget_brl FROM ai.budgets
            WHERE company_id = :companyId AND status = 'ACTIVE' AND agent_code IS NOT NULL AND (period_start AT TIME ZONE :tz)::date >= CAST(:from AS date) GROUP BY 1, 2)
     SELECT COALESCE(c.agent, b.agent) AS agent, COALESCE(c.month, b.month) AS month, COALESCE(c.cost_brl, 0) AS cost_brl, b.budget_brl, COALESCE(c.runs, 0) AS runs
       FROM c FULL JOIN b ON b.agent = c.agent AND b.month = c.month ORDER BY 1, 2`,
    { companyId, now, from: monthStart(window.from) }, transaction
  );
  return records.map(toRow(KEY));
}

const def = defineCompanyWideModel({ name: 'rm_ai_cost', keyColumns: KEY, events: AI_COST_EVENTS, build });

module.exports = { def, build };
