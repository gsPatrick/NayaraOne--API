'use strict';

/**
 * Rodada 25 — auditoria "loop até secar" (2026-10-05): contrato exige three-way match
 * "PO x receipt x invoice" e "invoice match = payable idempotente" — mas confirmGoodsReceipt só
 * comparava QUANTIDADE (PO x receipt), nunca o VALOR da nota fiscal, e nunca gerava o contas a
 * pagar (payable) a partir do recebimento confirmado. Esta migration adiciona o necessário pra
 * guardar o valor informado da nota e o lançamento financeiro gerado (idempotente por receipt).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      { tableName: 'goods_receipts', schema: 'procurement' },
      'invoice_total_amount',
      { type: Sequelize.DECIMAL(18, 2), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'goods_receipts', schema: 'procurement' },
      'financial_entry_id',
      {
        type: Sequelize.UUID, allowNull: true,
        references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
      }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn({ tableName: 'goods_receipts', schema: 'procurement' }, 'invoice_total_amount');
    await queryInterface.removeColumn({ tableName: 'goods_receipts', schema: 'procurement' }, 'financial_entry_id');
  },
};
