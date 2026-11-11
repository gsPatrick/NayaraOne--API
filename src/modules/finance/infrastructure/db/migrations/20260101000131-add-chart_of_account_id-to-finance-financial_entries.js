'use strict';

/**
 * Migration: adiciona "finance"."financial_entries"."chart_of_account_id" (M4-01).
 *
 * NULLABLE de propósito: todos os lançamentos já existentes foram criados antes do plano de
 * contas existir e não podem ser invalidados retroativamente (ledger imutável — FIN-003).
 * Classificação contábil é opcional no lançamento; quando informada, aponta para uma conta
 * analítica ativa do plano da mesma empresa.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'financial_entries', schema: 'finance' },
      'chart_of_account_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'chart_of_accounts', schema: 'finance' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
    await queryInterface.addIndex(
      { tableName: 'financial_entries', schema: 'finance' },
      ['chart_of_account_id'],
      { name: 'financial_entries_chart_of_account_idx' }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex({ tableName: 'financial_entries', schema: 'finance' }, 'financial_entries_chart_of_account_idx');
    await queryInterface.removeColumn({ tableName: 'financial_entries', schema: 'finance' }, 'chart_of_account_id');
  },
};
