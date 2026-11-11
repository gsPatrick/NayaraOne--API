'use strict';

/**
 * Migration (M4-21): adiciona campos de revisão manual antifraude em
 * "finance"."financial_entries".
 *
 * A anomalia detectada (valor muito acima da média histórica da MESMA conta bancária, ou
 * primeiro pagamento alto para uma conta sem histórico) é uma propriedade DO PAGAMENTO, não
 * da conta bancária — a mesma conta pode ter dezenas de pagamentos normais e um anômalo. Por
 * isso o flag mora no lançamento, e não em bank_accounts (que já tem o seu próprio mecanismo
 * de bloqueio/cooldown em `status`).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'financial_entries', schema: 'finance' },
      'requires_manual_review',
      { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }
    );
    await queryInterface.addColumn(
      { tableName: 'financial_entries', schema: 'finance' },
      'manual_review_reason',
      { type: Sequelize.TEXT, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'financial_entries', schema: 'finance' },
      'manual_review_cleared_at',
      { type: Sequelize.DATE, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'financial_entries', schema: 'finance' },
      'manual_review_cleared_by',
      { type: Sequelize.UUID, allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'financial_entries', schema: 'finance' }, 'manual_review_cleared_by');
    await queryInterface.removeColumn({ tableName: 'financial_entries', schema: 'finance' }, 'manual_review_cleared_at');
    await queryInterface.removeColumn({ tableName: 'financial_entries', schema: 'finance' }, 'manual_review_reason');
    await queryInterface.removeColumn({ tableName: 'financial_entries', schema: 'finance' }, 'requires_manual_review');
  },
};
