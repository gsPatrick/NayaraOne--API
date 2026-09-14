'use strict';

/**
 * Migration: adiciona "legal"."inspection_items"."damage_description" e "estimated_budget".
 *
 * FIX (reportado pela cliente 14/09/2026, escopo Marco 5 — Vistorias): a vistoria registrava
 * apenas a condição do item (GOOD/REGULAR/DAMAGED), sem espaço para descrever o dano
 * encontrado nem estimar o custo de reparo — obrigatório pra comparação entrada x saída gerar
 * um relatório útil de cobrança/orçamento.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'inspection_items', schema: 'legal' },
      'damage_description',
      { type: Sequelize.TEXT, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'inspection_items', schema: 'legal' },
      'estimated_budget',
      { type: Sequelize.DECIMAL(14, 2), allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'inspection_items', schema: 'legal' }, 'damage_description');
    await queryInterface.removeColumn({ tableName: 'inspection_items', schema: 'legal' }, 'estimated_budget');
  },
};
