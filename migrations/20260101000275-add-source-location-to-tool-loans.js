'use strict';

/**
 * Rodada 22 — auditoria "loop até secar" (2026-10-05): loanTool/returnTool nunca atualizavam
 * `asset.current_location_id` — EST-006 exige que a saída registre o destino, e EST-014 que o
 * Asset tenha localização condizente. `source_location_id` guarda de onde a ferramenta saiu
 * (currentLocationId do asset no momento do empréstimo), pra returnTool poder restaurá-lo.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      { tableName: 'tool_loans', schema: 'inventory' },
      'source_location_id',
      { type: Sequelize.UUID, allowNull: true }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn({ tableName: 'tool_loans', schema: 'inventory' }, 'source_location_id');
  },
};
