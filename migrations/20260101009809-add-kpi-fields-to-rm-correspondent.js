'use strict';

/**
 * Marco 9, demanda M9-D661 (KPIs do Correspondente Bancário): campos de cálculo e de qualidade que os KPIs precisam dos read models do Correspondente da M9-D619. Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da migration 9726. Idempotente. Faixa reservada: 9808 a 9815.
 *   rm_fin_provider_outcome     analysis_days_sum               soma dos dias de calendário de São Paulo entre o envio e a decisão
 *   rm_fin_commission           received_unlinked               comissões recebidas sem caso ou sem lançamento liquidado vinculado
 * Os dois são NULOS até o read model ser recalculado (evento ou rebuild): nulo quer dizer "ainda não calculado" e o KPI não mostra valor.
 */
const COLUMNS = [
  ['rm_fin_provider_outcome', 'analysis_days_sum integer CHECK (analysis_days_sum IS NULL OR analysis_days_sum >= 0)'],
  ['rm_fin_commission', 'received_unlinked integer CHECK (received_unlinked IS NULL OR received_unlinked >= 0)'],
];

module.exports = {
  up: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
