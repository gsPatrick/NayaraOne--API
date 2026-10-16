'use strict';

/**
 * Rodada 47 — auditoria "loop até secar" (2026-10-05): TAB-0751 exige numeric(18,4) pra
 * quantity — DECIMAL(9,6) dava overflow em movimentos acima de ~999 unidades.
 *
 * created_by (também NOT NULL no contrato) é enforced só no nível de aplicação
 * (movements.service.js#recordMovement + allowNull:false no model) — não alteramos a coluna
 * pra NOT NULL aqui porque isso exigiria um backfill de linhas legadas sem autor, e nenhuma
 * tabela de membership real foi confirmada neste ambiente pra escolher um ator de backfill
 * seguro. Sequelize já recusa qualquer INSERT novo com created_by nulo.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn(
      { tableName: 'inventory_movements', schema: 'inventory' },
      'quantity',
      { type: Sequelize.DECIMAL(18, 4), allowNull: false }
    );
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn(
      { tableName: 'inventory_movements', schema: 'inventory' },
      'quantity',
      { type: Sequelize.DECIMAL(9, 6), allowNull: false }
    );
  },
};
