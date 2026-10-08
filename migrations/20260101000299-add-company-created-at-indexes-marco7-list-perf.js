'use strict';

/**
 * GATE-DB-09 / DB-TS-015 ("Volume simulado de anos de operação → Metas p95 atendidas ou plano
 * de otimização"; contrato §16: "Metas iniciais: p95 < 300ms em consultas comuns") — auditoria
 * de carga real (seed de ~8k-160k linhas num tenant isolado de load test, medindo com
 * EXPLAIN ANALYZE direto no Postgres pra isolar custo de query de latência de rede) encontrou
 * que `purchase_orders`, `goods_receipts` e `inventory_movements` não tinham NENHUM índice em
 * `company_id` (só a FK, que o Postgres não indexa automaticamente) — `listPurchaseOrders`,
 * `listGoodsReceipts` e o `findAll` de movimentos (todos filtram por company_id/RLS e ordenam
 * por created_at/moved_at DESC) caem em Seq Scan + Sort. Em ~1.28M linhas isso já media
 * ~117ms de execução real (medido com EXPLAIN ANALYZE) — crescendo linearmente com o volume,
 * o que eventualmente passaria da meta de 300ms conforme "anos de operação" acumulam histórico.
 * Índice composto (company_id, created_at/moved_at DESC) resolve pra Index Scan: mesma consulta
 * caiu para ~2ms em 1.28M linhas (medido antes/depois, ver relatório da sessão).
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS purchase_orders_company_created_idx ON procurement.purchase_orders (company_id, created_at DESC)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS goods_receipts_company_created_idx ON procurement.goods_receipts (company_id, created_at DESC)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS inventory_movements_company_moved_idx ON inventory.inventory_movements (company_id, moved_at DESC)'
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS procurement.purchase_orders_company_created_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS procurement.goods_receipts_company_created_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS inventory.inventory_movements_company_moved_idx');
  },
};
