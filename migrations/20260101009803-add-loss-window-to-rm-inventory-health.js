'use strict';

/**
 * Marco 9, demanda M9-D653 (correção da reabertura): a janela das perdas de estoque passa a ser parâmetro do administrador
 * (analytics.estoque.janela_perdas_dias, padrão 30). O read model analytics.rm_inventory_health guarda a janela usada em cada linha
 * (`losses_window_days`), para que o KPI inv.losses, a origem e o detalhe usem exatamente a mesma janela com que o total foi calculado. As linhas
 * existentes foram calculadas com 30 dias, que é o padrão. Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da migration 9725. Idempotente.
 * Faixa reservada: 9800 a 9807.
 */
const T = '"analytics"."rm_inventory_health"';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS losses_window_days integer NOT NULL DEFAULT 30 CHECK (losses_window_days BETWEEN 1 AND 365)`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE ${T} DROP COLUMN IF EXISTS losses_window_days`);
  },
};
