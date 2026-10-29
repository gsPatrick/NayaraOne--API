'use strict';

/**
 * Marco 9, demanda M9-D670 (KPIs de Marketing): rm_mkt_campaign_month, o resultado mensal (mês de São Paulo) de cada campanha, para custo, leads e
 * atribuição. A linha com campaign_id = 00000000-0000-0000-0000-000000000000 é "Sem campanha". Só ids e agregados. Colunas:
 *   cost_settled    despesas REALIZADAS ligadas à campanha, no mês da liquidação (estorno parcial entra no mês da despesa estornada)
 *   cost_planned    despesas PENDENTES ligadas à campanha, no mês do vencimento (planejado)
 *   leads_total     leads de marketing (oportunidade com origem de marketing) criados no mês com a campanha (ou sem ela, na linha "Sem campanha")
 *   leads_last      desses, os atribuídos pelo toque LAST (evento LEAD_CREATED válido gravado pelo Marketing)
 *   leads_first     leads do mês cujo toque FIRST (gravado pelo Marketing) é desta campanha
 *   sales_last      oportunidades ganhas no mês originadas na campanha
 *   outside_window  vendas do mês que o Marketing não atribuiu por falta de toque válido na janela (linha "Sem campanha")
 * RLS ENABLE + FORCE e GRANT ao nayara_runtime com guarda de existência (apoio _helpers/analyticsReadModelTables). Idempotente.
 */
const { MONEY, COUNT, createReadModelTable, grantRuntime, dropTables } = require('./_helpers/analyticsReadModelTables');

const TABLE = {
  name: 'rm_mkt_campaign_month',
  key: ['campaign_id', 'month'],
  columns: [
    'campaign_id uuid NOT NULL', 'month varchar(7) NOT NULL CHECK (month ~ \'^[0-9]{4}-(0[1-9]|1[0-2])$\')',
    `${MONEY('cost_settled')} CHECK (cost_settled >= 0)`, `${MONEY('cost_planned')} CHECK (cost_planned >= 0)`,
    COUNT('leads_total'), COUNT('leads_last'), COUNT('leads_first'), COUNT('sales_last'), COUNT('outside_window'),
  ],
};

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('CREATE SCHEMA IF NOT EXISTS "analytics"');
    await createReadModelTable(q, TABLE);
    await grantRuntime(q, [TABLE.name]);
  },

  down: async (queryInterface) => dropTables((sql) => queryInterface.sequelize.query(sql), [TABLE.name]),
};
