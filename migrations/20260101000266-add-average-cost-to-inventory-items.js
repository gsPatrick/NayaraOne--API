'use strict';

/**
 * Migration: EST-011 — custo usado na obra vem de uma política definida (custo médio
 * ponderado), nunca de digitação manual nem duplicado no Financeiro. average_cost é
 * recalculado SOMENTE em confirmReceipt (receipts.service.js), com base no unitCost de cada
 * receipt_item — nenhum outro ponto do código escreve neste campo.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'inventory_items', schema: 'inventory' },
      'average_cost',
      { type: Sequelize.DECIMAL(18, 6), allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'inventory_items', schema: 'inventory' }, 'average_cost');
  },
};
