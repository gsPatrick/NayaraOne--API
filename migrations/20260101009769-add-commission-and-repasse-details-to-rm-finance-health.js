'use strict';

/**
 * Marco 9, demanda M9-D623 (KPIs de comissões provisionadas e pagas e repasses pendentes ao proprietário): acrescenta ao read model
 * analytics.rm_finance_health os agregados que reproduzem os KPIs além dos totais que já existiam: comissões provisionadas e pagas por corretor e
 * por tipo, parcelas sem corretor e pagas sem lançamento (regras de qualidade) e repasses pendentes por proprietário, por imóvel e por data de
 * criação com a idade em dias corridos e em dias úteis. Só agregados e ids técnicos (nenhum nome nem documento). Nenhuma tabela nova: RLS, FORCE e
 * GRANT da tabela continuam os da migration 9709. Idempotente. Faixa reservada: 9768 a 9775.
 */
const T = '"analytics"."rm_finance_health"';
const COLUMNS = [
  "provisioned_commissions_detail jsonb NOT NULL DEFAULT '{}'::jsonb",
  "paid_commissions_detail jsonb NOT NULL DEFAULT '{}'::jsonb",
  "owner_repasses_detail jsonb NOT NULL DEFAULT '{}'::jsonb",
];

module.exports = {
  up: async (queryInterface) => {
    for (const column of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const column of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE ${T} DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
