'use strict';

/**
 * Marco 9, demanda M9-D640 (KPIs de contratos ativos, vacância e inadimplência da locação): campos de cálculo e de qualidade que os KPIs precisam dos read models de
 * Locação da M9-D617. Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da migration 9718. Idempotente. Faixa reservada: 9875 a 9882.
 *   rm_rental_contracts   without_rent          contratos sem valor de aluguel (regra de qualidade: DEGRADED nos ACTIVE)
 *                         by_property           por imóvel: quantidade e aluguel; by_owner: o mesmo pelo proprietário principal
 *                         rent_distribution     aluguéis distintos com a quantidade de cada um (a fórmula aplica as faixas de valor do administrador)
 *   rm_rental_vacancy     status_undefined      imóveis com oferta de locação ou contrato e situação vazia ou desconhecida (regra de qualidade: DEGRADED)
 *                         by_type, by_neighborhood, by_owner   locáveis e alugados por tipo, bairro e proprietário principal
 *   rm_rental_arrears     unlinked_amount, unlinked_count   entradas próprias vencidas que não são de contrato de locação (ficam só no Financeiro)
 *                         without_due_date      entradas de locação pendentes sem vencimento
 *                         by_age, by_contract, by_property   vencido de locação por dia de vencimento, por contrato e por imóvel
 * Os contadores e valores escalares ficam NULOS até o read model ser recalculado (evento, agenda ou rebuild): nulo quer dizer "ainda não calculado" e o KPI não mostra valor.
 */
const COLUMNS = [
  ['rm_rental_contracts', 'without_rent integer CHECK (without_rent IS NULL OR without_rent >= 0)'],
  ['rm_rental_contracts', "by_property jsonb NOT NULL DEFAULT '{}'::jsonb"],
  ['rm_rental_contracts', "by_owner jsonb NOT NULL DEFAULT '{}'::jsonb"],
  ['rm_rental_contracts', "rent_distribution jsonb NOT NULL DEFAULT '[]'::jsonb"],
  ['rm_rental_vacancy', 'status_undefined integer CHECK (status_undefined IS NULL OR status_undefined >= 0)'],
  ['rm_rental_vacancy', "by_type jsonb NOT NULL DEFAULT '{}'::jsonb"],
  ['rm_rental_vacancy', "by_neighborhood jsonb NOT NULL DEFAULT '{}'::jsonb"],
  ['rm_rental_vacancy', "by_owner jsonb NOT NULL DEFAULT '{}'::jsonb"],
  ['rm_rental_arrears', 'unlinked_amount numeric(18,2)'],
  ['rm_rental_arrears', 'unlinked_count integer CHECK (unlinked_count IS NULL OR unlinked_count >= 0)'],
  ['rm_rental_arrears', 'without_due_date integer CHECK (without_due_date IS NULL OR without_due_date >= 0)'],
  ['rm_rental_arrears', "by_age jsonb NOT NULL DEFAULT '[]'::jsonb"],
  ['rm_rental_arrears', "by_contract jsonb NOT NULL DEFAULT '{}'::jsonb"],
  ['rm_rental_arrears', "by_property jsonb NOT NULL DEFAULT '{}'::jsonb"],
];

module.exports = {
  up: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
