'use strict';

/**
 * BUG REAL CORRIGIDO (auditoria "ciclos até secar", Ciclo 3, Frente C — idempotência faltante,
 * 2026-10-09, Marco 6/Obras): `createChangeOrder` (construction/changeOrders.service.js) não
 * tinha nenhuma proteção contra duplicidade (nem idempotencyKey, nem UNIQUE constraint). Um
 * retry de rede (comum em obra, com conexão instável) ou duplo-clique no formulário criava 2
 * Change Orders idênticos em PENDING_APPROVAL; se ambos fossem aprovados, `budgetImpact` era
 * aplicado 2x em budget.baselineAmount/totalAmount e project.budgetAmount — dano financeiro
 * real e direto (mesma classe de bug já corrigida em materialRequests/stageMeasurements/
 * dailyReports/lossRecords).
 *
 * Fix: nova coluna idempotency_key, única por empresa (partial index — mesmo padrão já usado
 * nas demais entidades reexecutáveis), e o service passa a EXIGIR o campo (ver
 * changeOrders.service.js createChangeOrder).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Idempotente: outra tentativa anterior (sem conseguir marcar SequelizeMeta, por falta de
    // credencial de DDL na hora) já pode ter criado a coluna/índice.
    const [cols] = await queryInterface.sequelize.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'construction' AND table_name = 'change_orders' AND column_name = 'idempotency_key'`
    );
    if (!cols.length) {
      await queryInterface.addColumn(
        { tableName: 'change_orders', schema: 'construction' },
        'idempotency_key',
        { type: Sequelize.STRING(255), allowNull: true }
      );
    }
    const [idx] = await queryInterface.sequelize.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'construction' AND tablename = 'change_orders' AND indexname = 'change_orders_company_idempotency_unique'`
    );
    if (!idx.length) {
      await queryInterface.addIndex(
        { tableName: 'change_orders', schema: 'construction' },
        ['company_id', 'idempotency_key'],
        { name: 'change_orders_company_idempotency_unique', unique: true, where: { idempotency_key: { [Sequelize.Op.ne]: null } } }
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.removeIndex({ tableName: 'change_orders', schema: 'construction' }, 'change_orders_company_idempotency_unique');
    await queryInterface.removeColumn({ tableName: 'change_orders', schema: 'construction' }, 'idempotency_key');
  },
};
