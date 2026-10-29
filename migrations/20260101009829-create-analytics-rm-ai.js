'use strict';

/**
 * Marco 9, demanda M9-D628: read models de IA do BI (schema analytics, RLS ENABLE + FORCE por company_id), por agente da NAY.
 *  - rm_ai_cost (agent, month): custo em reais com 2 casas das execuções do mês de São Paulo (ai.ai_runs.cost_amount) e o orçamento mensal ativo do agente
 *    (ai.budgets); budget_brl nulo = agente sem orçamento mensal;
 *  - rm_ai_quality (agent, week): pontuação de fundamentação (execuções GROUNDED valem 1, as demais com fundamentação aplicável valem 0) e pontuação
 *    de avaliação (soma dos scores dos itens das avaliações encerradas na semana), com as contagens que permitem a média sem arredondar antes;
 *  - rm_ai_tool_calls (agent, day): chamadas de ferramenta e as bloqueadas.
 * Nenhum prompt, resposta, argumento ou conteúdo: só contagens, custos e pontuações. A semana começa na segunda-feira (data de calendário de São Paulo).
 * Faixa reservada: 9826 a 9833.
 */
const { MONEY, COUNT, createReadModelTable, grantRuntime, dropTables } = require('./_helpers/analyticsReadModelTables');

const TABLES = [
  {
    name: 'rm_ai_cost',
    key: ['agent', 'month'],
    columns: ['agent varchar(64) NOT NULL', "month varchar(7) NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')", MONEY('cost_brl'), MONEY('budget_brl', { nullable: true }), COUNT('runs')],
  },
  {
    name: 'rm_ai_quality',
    key: ['agent', 'week'],
    columns: [
      'agent varchar(64) NOT NULL', 'week date NOT NULL', COUNT('runs'), COUNT('grounding_runs'), 'grounding_score_sum numeric(14,4) NOT NULL DEFAULT 0 CHECK (grounding_score_sum >= 0)',
      COUNT('eval_items'), 'eval_score_sum numeric(14,4) NOT NULL DEFAULT 0 CHECK (eval_score_sum >= 0)',
    ],
  },
  {
    name: 'rm_ai_tool_calls',
    key: ['agent', 'day'],
    columns: ['agent varchar(64) NOT NULL', 'day date NOT NULL', COUNT('calls'), COUNT('blocked'), 'CONSTRAINT rm_ai_tool_calls_blocked_chk CHECK (blocked <= calls)'],
  },
];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('CREATE SCHEMA IF NOT EXISTS "analytics"');
    for (const table of TABLES) await createReadModelTable(q, table);
    await grantRuntime(q, TABLES.map((t) => t.name));
  },

  down: async (queryInterface) => {
    await dropTables((sql) => queryInterface.sequelize.query(sql), TABLES.map((t) => t.name).reverse());
  },
};
