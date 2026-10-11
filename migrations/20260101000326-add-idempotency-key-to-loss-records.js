'use strict';

/**
 * BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-09, Marco 6/Obras — mesmo padrão do
 * achado em inventory.movements.service.js/recordMovement: ADJUSTMENT/LOSS/DISPOSAL são
 * REEXECUTÁVEIS — reenvio por timeout/retry de rede/duplo-clique não pode criar segunda
 * obrigação): `createLossRecord` (construction/lossRecords.service.js) registra uma perda de
 * material e, quando `estimatedValue` está dentro da alçada configurada, AUTOAPROVA o registro
 * na hora (status já nasce "APPROVED", sem nenhuma revisão humana) — e esse valor entra direto
 * em `totalLossValue` usado por projectHealth.service.js/dashboard.service.js pra margem/custo
 * da obra. Não havia NENHUMA proteção contra duplicidade: nem campo de idempotência (a coluna
 * não existia), nem UNIQUE constraint que pegasse o caso. Um retry de rede no mesmo
 * lançamento de perda duplicava o valor reportado de perda (e a quantidade de material dado
 * como perdido) sem qualquer humano no caminho.
 *
 * Fix: nova coluna idempotency_key, única por empresa (partial index — mesmo padrão de
 * goods_receipts/payment_intents/inventory_movements/stage_measurements), e o service passa a
 * EXIGIR o campo (ver lossRecords.service.js createLossRecord).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Idempotente: outra tentativa anterior (sem conseguir marcar SequelizeMeta, por falta de
    // credencial de DDL na hora) já pode ter criado a coluna/índice.
    const [cols] = await queryInterface.sequelize.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'construction' AND table_name = 'loss_records' AND column_name = 'idempotency_key'`
    );
    if (!cols.length) {
      await queryInterface.addColumn(
        { tableName: 'loss_records', schema: 'construction' },
        'idempotency_key',
        { type: Sequelize.STRING(255), allowNull: true }
      );
    }
    const [idx] = await queryInterface.sequelize.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'construction' AND tablename = 'loss_records' AND indexname = 'loss_records_company_idempotency_unique'`
    );
    if (!idx.length) {
      await queryInterface.addIndex(
        { tableName: 'loss_records', schema: 'construction' },
        ['company_id', 'idempotency_key'],
        { name: 'loss_records_company_idempotency_unique', unique: true, where: { idempotency_key: { [Sequelize.Op.ne]: null } } }
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.removeIndex({ tableName: 'loss_records', schema: 'construction' }, 'loss_records_company_idempotency_unique');
    await queryInterface.removeColumn({ tableName: 'loss_records', schema: 'construction' }, 'idempotency_key');
  },
};
