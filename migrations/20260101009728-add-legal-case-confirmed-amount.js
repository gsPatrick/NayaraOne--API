'use strict';

/**
 * Marco 9, demanda M9-D619: legal.legal_cases.confirmed_amount (opcional) é o valor já confirmado do processo (condenação, acordo ou
 * perda), que o BI mostra SEPARADO do valor estimado (M9-D610, M9-D660). Idempotente; a tabela já tem RLS FORCE.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query('ALTER TABLE "legal"."legal_cases" ADD COLUMN IF NOT EXISTS confirmed_amount numeric(18,2) CHECK (confirmed_amount IS NULL OR confirmed_amount >= 0)');
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('ALTER TABLE "legal"."legal_cases" DROP COLUMN IF EXISTS confirmed_amount');
  },
};
