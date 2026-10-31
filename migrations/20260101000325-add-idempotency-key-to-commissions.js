'use strict';

/**
 * BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-09 — mesmo padrão do achado em
 * inventory.movements.service.js/recordMovement: operação reexecutável sem chave de
 * idempotência obrigatória): `createCommission` (finance/commissions.service.js) cria o
 * DIREITO à comissão (Commission + N CommissionInstallment) diretamente a partir de um
 * payload manual (POST /finance/commissions), sem NENHUMA proteção contra duplo-envio —
 * nem campo de idempotência (não existia a coluna), nem UNIQUE constraint que pegasse o caso
 * (opportunityId/contractId são opcionais e não têm índice único). Um retry de rede/duplo-clique
 * no mesmo cálculo de comissão cria DUAS obrigações de pagamento ao mesmo beneficiário pelo
 * mesmo valor — dinheiro real duplicado no ledger de comissões.
 *
 * Fix: nova coluna `idempotency_key`, única por empresa (partial index, NULL não colide —
 * mesmo padrão de goods_receipts/payment_intents/inventory_movements), e o service passa a
 * EXIGIR o campo (ver commissions.service.js createCommission).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      { tableName: 'commissions', schema: 'finance' },
      'idempotency_key',
      { type: Sequelize.STRING(255), allowNull: true }
    );
    await queryInterface.addIndex(
      { tableName: 'commissions', schema: 'finance' },
      ['company_id', 'idempotency_key'],
      { name: 'commissions_company_idempotency_unique', unique: true, where: { idempotency_key: { [Sequelize.Op.ne]: null } } }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex({ tableName: 'commissions', schema: 'finance' }, 'commissions_company_idempotency_unique');
    await queryInterface.removeColumn({ tableName: 'commissions', schema: 'finance' }, 'idempotency_key');
  },
};
