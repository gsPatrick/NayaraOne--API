'use strict';

/**
 * GATE-DB-09 / DB-TS-015 (contrato §16: "p95 < 300ms em consultas comuns") — continuação da
 * auditoria de carga da migration 20260101000299, agora cobrindo as 14 funções `list*` de
 * Marco 7 que só tinham `limit: 1500` defensivo e nunca haviam sido medidas com volume real.
 * Seed de 1M linhas num tenant isolado (load test, apagado ao final) + EXPLAIN ANALYZE real
 * encontrou as 4 funções com maior probabilidade de crescer com "anos de operação" todas em
 * Seq Scan + Sort, sem nenhum índice além da PK:
 *
 *   - listReceipts            (inventory.receipts)             ~73ms  em 1M linhas
 *   - listToolLoans           (inventory.tool_loans)           ~147ms em 1M linhas
 *   - listAssetMovements      (inventory.asset_movements)      ~432ms em 1M linhas (ESTOURA a meta de 300ms)
 *   - listDiscrepancies       (procurement.receipt_discrepancies) ~103ms em 1M linhas
 *
 * `listAssetMovements` filtra por asset_id específico (não a empresa toda) e ordena por
 * moved_at DESC — por isso o índice é (asset_id, moved_at DESC), não (company_id, ...); as
 * outras três filtram por company_id/RLS e ordenam por created_at DESC, mesmo padrão da
 * migration 20260101000299. Depois do índice composto, todas as 4 caem para Index Scan.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS receipts_company_created_idx ON inventory.receipts (company_id, created_at DESC)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS tool_loans_company_created_idx ON inventory.tool_loans (company_id, created_at DESC)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS asset_movements_asset_moved_idx ON inventory.asset_movements (asset_id, moved_at DESC)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS receipt_discrepancies_company_created_idx ON procurement.receipt_discrepancies (company_id, created_at DESC)'
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS inventory.receipts_company_created_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS inventory.tool_loans_company_created_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS inventory.asset_movements_asset_moved_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS procurement.receipt_discrepancies_company_created_idx');
  },
};
