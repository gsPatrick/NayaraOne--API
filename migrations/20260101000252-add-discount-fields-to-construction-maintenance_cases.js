'use strict';

/**
 * BUG REAL CORRIGIDO (30/09/2026, achado numa nova rodada de verificação de integrações do
 * Marco 6): a fonte é explícita — "Desconto/ressarcimento passa por regra/aprovação e
 * Financeiro" (seção "9. Qualidade, entrega e pós-obra"). `maintenance_cases` não tinha NENHUM
 * campo pra registrar desconto/ressarcimento ao cliente decorrente de um caso de garantia, nem
 * fluxo de aprovação, nem integração com o Financeiro — funcionalidade inteira ausente, não
 * divergência de nome.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'maintenance_cases', schema: 'construction' },
      'resolution_type',
      { type: Sequelize.STRING(16), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'maintenance_cases', schema: 'construction' },
      'resolution_amount',
      { type: Sequelize.DECIMAL(18, 2), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'maintenance_cases', schema: 'construction' },
      'resolution_status',
      { type: Sequelize.STRING(24), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'maintenance_cases', schema: 'construction' },
      'resolution_approved_by_user_id',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'maintenance_cases', schema: 'construction' },
      'resolution_financial_entry_id',
      { type: Sequelize.UUID, allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'maintenance_cases', schema: 'construction' }, 'resolution_financial_entry_id');
    await queryInterface.removeColumn({ tableName: 'maintenance_cases', schema: 'construction' }, 'resolution_approved_by_user_id');
    await queryInterface.removeColumn({ tableName: 'maintenance_cases', schema: 'construction' }, 'resolution_status');
    await queryInterface.removeColumn({ tableName: 'maintenance_cases', schema: 'construction' }, 'resolution_amount');
    await queryInterface.removeColumn({ tableName: 'maintenance_cases', schema: 'construction' }, 'resolution_type');
  },
};
