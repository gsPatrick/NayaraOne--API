'use strict';

/**
 * Marco 9, demanda M9-D618 (Caderno "Dashboards + BI + Centro de Comando", §9 KPIs Obras, §5 painéis Obras, Estoque/Patrimônio, Pós-obra):
 * read models de Obras, Estoque/Patrimônio e Pós-obra no schema analytics, todos com RLS ENABLE + FORCE por company_id.
 *
 *  - rm_project_progress / rm_project_cost / rm_project_delays / rm_project_measurements: uma linha por obra.
 *  - rm_project_nonconformities (obra, causa, equipe), rm_project_waste (obra, material), rm_postwork_cost (obra, causa, equipe, material):
 *    uma linha por combinação das dimensões. Causa, equipe e material sem informação entram como 'NAO_INFORMADA' (a chave nunca é nula).
 *  - rm_inventory_health e rm_tool_assets: uma linha por empresa e data-base (dependem do relógio).
 * Só ids, rótulos de equipe e agregados: nenhum nome nem documento de pessoa. Colunas além das do livro (marcadas na demanda) guardam os
 * componentes que a D651/D652/D653 precisam para média, idade e percentual sem voltar à fonte. Faixa reservada: 9725 a 9732.
 */
const { MONEY, COUNT, createReadModelTable, grantRuntime, dropTables } = require('./_helpers/analyticsReadModelTables');

const P = 'project_id uuid NOT NULL';
const PCT = (name) => `${name} numeric(12,6)`;
const TABLES = [
  { name: 'rm_project_progress', key: ['project_id'], columns: [P, PCT('baseline_percent'), PCT('actual_percent'), 'forecast_finish_date date', 'baseline_finish_date date', COUNT('stages_total')] },
  { name: 'rm_project_cost', key: ['project_id'], columns: [P, MONEY('budget_cost', { nullable: true }), MONEY('actual_cost'), MONEY('forecast_cost', { nullable: true }), MONEY('contract_revenue')] },
  { name: 'rm_project_delays', key: ['project_id'], columns: [P, COUNT('delayed_stages'), COUNT('max_delay_days'), COUNT('delay_days_sum'), COUNT('stages_without_date')] },
  { name: 'rm_project_measurements', key: ['project_id'], columns: [P, MONEY('measured_value'), MONEY('approved_value'), MONEY('pending_value'), 'oldest_pending_since date'] },
  {
    name: 'rm_project_nonconformities',
    key: ['project_id', 'cause', 'team_id'],
    columns: [P, 'cause varchar(64) NOT NULL', 'team_id varchar(120) NOT NULL', COUNT('open'), COUNT('closed_30d'), COUNT('close_days_sum')],
  },
  {
    name: 'rm_project_waste',
    key: ['project_id', 'material_id'],
    columns: [P, 'material_id uuid NOT NULL', MONEY('waste_value'), 'waste_quantity numeric(18,3) NOT NULL DEFAULT 0', COUNT('movements_without_cost'), MONEY('consumption_value')],
  },
  {
    name: 'rm_postwork_cost',
    key: ['project_id', 'cause', 'team_id', 'material_id'],
    columns: [P, 'cause varchar(64) NOT NULL', 'team_id varchar(120) NOT NULL', 'material_id varchar(255) NOT NULL', COUNT('cases_open'), COUNT('cases_total'), MONEY('warranty_cost')],
  },
  { name: 'rm_inventory_health', key: ['as_of_date'], columns: ['as_of_date date NOT NULL', MONEY('stock_value'), COUNT('items_below_min'), COUNT('ruptures'), MONEY('losses_30d'), COUNT('items_without_min'), COUNT('items_without_cost')] },
  { name: 'rm_tool_assets', key: ['as_of_date'], columns: ['as_of_date date NOT NULL', COUNT('loans_open'), COUNT('loans_overdue'), COUNT('assets_in_maintenance'), COUNT('loans_without_due_date')] },
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
