'use strict';

/**
 * Marco 9, demanda M9-D622 (KPIs de inadimplência, taxa e necessidade para respirar): o read model analytics.rm_finance_health passa a guardar o
 * detalhe das entradas próprias vencidas (por dia de vencimento, por contrato e a janela usada), para o valor inadimplente e a taxa saírem por faixa
 * de atraso e por contrato sem voltar ao OLTP. Só ids técnicos e agregados. Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da migration 9709.
 * Idempotente. Faixa reservada: 9875 a 9882.
 */
const T = '"analytics"."rm_finance_health"';
const COLUMN = "overdue_receivables_detail jsonb NOT NULL DEFAULT '{}'::jsonb";

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS ${COLUMN}`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE ${T} DROP COLUMN IF EXISTS overdue_receivables_detail`);
  },
};
