'use strict';

/**
 * BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 64, 2026-10-06): confirmGoodsReceipt
 * usava `idempotencyKey: \`goods-receipt:${goodsReceipt.id}\`` no FinancialEntry do payable —
 * mas goodsReceipt.id é gerado DENTRO da própria chamada, então essa chave nunca pode colidir
 * entre duas chamadas (não protege nada). A única proteção real contra duplicidade era o lock
 * FOR UPDATE + status do PurchaseOrder, que só bloqueia quando o recebimento é TOTAL (PO sai de
 * OPEN); em recebimento PARCIAL (PO continua OPEN), um retry de rede/duplo-toque com o mesmo
 * payload cria um segundo GoodsReceipt + segundo FinancialEntry duplicado. A constraint única de
 * invoice_fingerprint não ajuda porque o campo é opcional (NULL não colide com NULL no índice).
 * Fix: aceitar idempotencyKey opcional do cliente (mesmo padrão de transferAsset/AssetMovement),
 * único por empresa.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      { tableName: 'goods_receipts', schema: 'procurement' },
      'idempotency_key',
      { type: Sequelize.STRING(255), allowNull: true }
    );
    await queryInterface.addIndex(
      { tableName: 'goods_receipts', schema: 'procurement' },
      ['company_id', 'idempotency_key'],
      { name: 'goods_receipts_company_idempotency_unique', unique: true, where: { idempotency_key: { [Sequelize.Op.ne]: null } } }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex({ tableName: 'goods_receipts', schema: 'procurement' }, 'goods_receipts_company_idempotency_unique');
    await queryInterface.removeColumn({ tableName: 'goods_receipts', schema: 'procurement' }, 'idempotency_key');
  },
};
