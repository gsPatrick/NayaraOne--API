'use strict';

/**
 * Rodada 12 — auditoria "loop até secar" (2026-10-05): ReceiptDiscrepancy tinha `status` com
 * DEFAULT 'OPEN' projetado pra ter transição, mas nenhum campo/serviço jamais fechava o case
 * (contrato: "divergência abre case" — three-way match). Esta migration adiciona as colunas
 * necessárias pra resolver o case e manter rastro de quem/quando/porquê.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      { tableName: 'receipt_discrepancies', schema: 'procurement' },
      'resolution_notes',
      { type: Sequelize.TEXT, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'receipt_discrepancies', schema: 'procurement' },
      'resolved_by_user_id',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'receipt_discrepancies', schema: 'procurement' },
      'resolved_at',
      { type: Sequelize.DATE, allowNull: true }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn({ tableName: 'receipt_discrepancies', schema: 'procurement' }, 'resolution_notes');
    await queryInterface.removeColumn({ tableName: 'receipt_discrepancies', schema: 'procurement' }, 'resolved_by_user_id');
    await queryInterface.removeColumn({ tableName: 'receipt_discrepancies', schema: 'procurement' }, 'resolved_at');
  },
};
