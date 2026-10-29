'use strict';

/**
 * Marco 9, demanda M9-D652 (KPI custo pós-obra): acrescenta ao read model analytics.rm_postwork_cost o custo dos casos de garantia ainda abertos
 * (`warranty_cost_open`), que o KPI mostra em separado como "previsto" (o custo dos casos já encerrados é o realizado). Nenhuma tabela nova: RLS, FORCE
 * e GRANT continuam os da migration 9725. Idempotente. Faixa reservada: 9800 a 9807.
 */
const T = '"analytics"."rm_postwork_cost"';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS warranty_cost_open numeric(18,2) NOT NULL DEFAULT 0`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE ${T} DROP COLUMN IF EXISTS warranty_cost_open`);
  },
};
