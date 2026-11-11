'use strict';

/** Migration: adiciona "finance"."financial_entries".description — memo/histórico do lançamento
 *  (não faz parte do fato financeiro imutável em si; é metadado editável enquanto PENDING). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'financial_entries', schema: 'finance' },
      'description',
      { type: Sequelize.STRING(255), allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'financial_entries', schema: 'finance' }, 'description');
  },
};
