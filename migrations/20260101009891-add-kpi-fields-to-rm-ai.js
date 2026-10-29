'use strict';

/**
 * Marco 9, demanda M9-D681 (KPIs de IA do BI): campos de cálculo que os KPIs precisam dos read models de IA da M9-D628. Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da
 * migration 9829. Idempotente. Faixa reservada: 9891 a 9898.
 *   rm_ai_cost         runs_without_cost  execuções concluídas que chamaram modelo e não gravaram custo (regra de qualidade do ai.cost_by_agent: DEGRADED)
 *                      by_model           { modelo: { cost_brl, runs } } do agente no mês (dimensão "modelo")
 *   rm_ai_tool_calls   by_tool            { ferramenta: { calls, blocked } } do agente no dia (dimensão "ferramenta")
 *                      by_reason          { motivo: bloqueadas } do agente no dia (dimensão "motivo"; NO_REASON = bloqueio sem motivo)
 * Todos NULOS até o read model ser recalculado (evento, agenda ou rebuild): nulo quer dizer "ainda não calculado" e o KPI não mostra valor.
 */
const COLUMNS = [
  ['rm_ai_cost', 'runs_without_cost integer CHECK (runs_without_cost IS NULL OR runs_without_cost >= 0)'],
  ['rm_ai_cost', "by_model jsonb CHECK (by_model IS NULL OR jsonb_typeof(by_model) = 'object')"],
  ['rm_ai_tool_calls', "by_tool jsonb CHECK (by_tool IS NULL OR jsonb_typeof(by_tool) = 'object')"],
  ['rm_ai_tool_calls', "by_reason jsonb CHECK (by_reason IS NULL OR jsonb_typeof(by_reason) = 'object')"],
];

module.exports = {
  up: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
