'use strict';

/**
 * Rodada 40 — auditoria "loop até secar" (2026-10-05): payInsurancePolicyInstallment não tinha
 * lock pessimista (corrigido no service), mas a garantia final e definitiva contra "duas
 * parcelas pagas com o mesmo lançamento financeiro" precisa estar no banco, não só na
 * aplicação. Índice único PARCIAL (ignora NULL — maioria das parcelas ainda não pagas) em
 * financial_entry_id.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addIndex(
      { tableName: 'insurance_installments', schema: 'procurement' },
      ['financial_entry_id'],
      {
        name: 'insurance_installments_financial_entry_id_unique',
        unique: true,
        where: { financial_entry_id: { [Sequelize.Op.ne]: null } },
      }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      { tableName: 'insurance_installments', schema: 'procurement' },
      'insurance_installments_financial_entry_id_unique'
    );
  },
};
