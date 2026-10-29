'use strict';

/**
 * Marco 9, demanda M9-D653 (KPI perdas de estoque): acrescenta ao read model analytics.rm_inventory_health a quantidade de perdas decididas na janela de
 * 30 dias (`losses_30d_count`), os casos de perda ainda abertos (`losses_open`) e as perdas decididas sem valor nenhum (`losses_without_value`, que
 * deixa o KPI DEGRADED). Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da migration 9725. Idempotente. Faixa reservada: 9800 a 9807.
 */
const T = '"analytics"."rm_inventory_health"';
const COLUMNS = ['losses_30d_count', 'losses_open', 'losses_without_value'];

module.exports = {
  up: async (queryInterface) => {
    for (const c of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS ${c} integer NOT NULL DEFAULT 0 CHECK (${c} >= 0)`);
  },

  down: async (queryInterface) => {
    for (const c of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE ${T} DROP COLUMN IF EXISTS ${c}`);
  },
};
