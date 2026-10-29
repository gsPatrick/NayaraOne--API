'use strict';

/**
 * Marco 9, demanda M9-D619 (Caderno "Dashboards + BI + Centro de Comando", §10 KPIs Jurídico/Correspondente): read models do Jurídico e do
 * Correspondente Bancário no schema analytics, todos com RLS ENABLE + FORCE por company_id.
 *
 *  - rm_legal_deadlines: prazos abertos por data-base, em faixas disjuntas do calendário de São Paulo (hoje até hoje+6, hoje+7 até hoje+29,
 *    vencidos); depende do relógio.
 *  - rm_legal_cases_risk (risco, tipo), rm_legal_values (tipo, risco), rm_legal_missing_docs (tipo de exigência; 'TODOS' = a empresa).
 *  - rm_fin_cases_stage (estágio), rm_fin_provider_outcome (provider, produto, mês da decisão), rm_fin_commission (provider).
 * Nenhuma parte, teor, advogado ou nome entra: só contagens, níveis, estágios, providers e valores. Estimado e confirmado ficam em colunas
 * separadas (M9-D610). Faixa reservada: 9725 a 9732.
 */
const { MONEY, COUNT, createReadModelTable, grantRuntime, dropTables } = require('./_helpers/analyticsReadModelTables');

const TABLES = [
  {
    name: 'rm_legal_deadlines',
    key: ['as_of_date'],
    columns: ['as_of_date date NOT NULL', COUNT('due_next_7d'), COUNT('due_7_to_29d'), COUNT('overdue'), 'oldest_overdue_days integer CHECK (oldest_overdue_days IS NULL OR oldest_overdue_days >= 1)', COUNT('open_total')],
  },
  { name: 'rm_legal_cases_risk', key: ['risk_level', 'case_type'], columns: ['risk_level varchar(32) NOT NULL', 'case_type varchar(64) NOT NULL', COUNT('count')] },
  {
    name: 'rm_legal_values',
    key: ['case_type', 'risk_level'],
    columns: ['case_type varchar(64) NOT NULL', 'risk_level varchar(32) NOT NULL', MONEY('estimated_total'), MONEY('confirmed_total'), COUNT('cases_without_value')],
  },
  {
    name: 'rm_legal_missing_docs',
    key: ['requirement_type'],
    columns: ['requirement_type varchar(64) NOT NULL', COUNT('contracts_missing'), COUNT('requirements_pending')],
  },
  { name: 'rm_fin_cases_stage', key: ['stage'], columns: ['stage varchar(40) NOT NULL', COUNT('count'), COUNT('days_in_stage_sum')] },
  {
    name: 'rm_fin_provider_outcome',
    key: ['provider', 'product', 'period_month'],
    columns: [
      'provider varchar(64) NOT NULL', 'product varchar(64) NOT NULL',
      "period_month varchar(7) NOT NULL CHECK (period_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')",
      COUNT('approved'), COUNT('rejected'), 'analysis_hours_sum numeric(14,2) NOT NULL DEFAULT 0 CHECK (analysis_hours_sum >= 0)', COUNT('analysis_count'),
    ],
  },
  { name: 'rm_fin_commission', key: ['provider'], columns: ['provider varchar(64) NOT NULL', MONEY('expected'), MONEY('confirmed'), MONEY('received')] },
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
