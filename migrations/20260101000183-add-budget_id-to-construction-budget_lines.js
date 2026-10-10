'use strict';

/**
 * Migration: adiciona "budget_id" em "construction"."budget_lines" — vínculo da linha solta de
 * orçamento ao agregado "construction"."budgets" criado na migração anterior (M6-04/M6-05).
 * Nullable de propósito: linhas de orçamento criadas antes desta migração (ou linhas soltas
 * fora de um agregado formal) continuam válidas — o vínculo é usado para agregar `total_amount`
 * no momento da aprovação (`approveBudget`) e para localizar quais linhas ficam bloqueadas
 * para UPDATE direto depois que o orçamento vira `APPROVED` (M6-17).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'budget_lines', schema: 'construction' },
      'budget_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'budgets', schema: 'construction' }, key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'budget_lines', schema: 'construction' }, 'budget_id');
  },
};
