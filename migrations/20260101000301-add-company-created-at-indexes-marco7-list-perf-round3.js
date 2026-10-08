'use strict';

/**
 * GATE-DB-09 / DB-TS-015 (contrato §16: "p95 < 300ms em consultas comuns") — rodada 3 da
 * auditoria de carga das 17 funções `list*` de Marco 7 (rodadas 1 e 2: migrations
 * 20260101000299 e 20260101000300). Esta rodada cobre as 10 funções restantes:
 * listItems, listLocations, listRequisitions, listCounts, listLossCases,
 * listMaintenanceOrders, listAssets, listBalancesByItem, listSupplierQualifications,
 * listPolicies.
 *
 * Tenant isolado de carga (criado e apagado ao final da auditoria, nunca tocou o tenant de
 * homologação) com volume realista: assets 1.000.000, maintenance_orders 1.000.000,
 * loss_cases 1.000.000, requisitions 1.000.000 (+ requisition_items 1.000.000), counts
 * 500.000, supplier_qualifications 300.000 (limitado por unique(company_id,
 * supplier_person_id) — exige 1 pessoa fornecedora distinta por linha), insurance_policies
 * 300.000 (+ coverages/claims/renewal_tasks 300.000 cada, os 3 includes de listPolicies).
 *
 * EXPLAIN ANALYZE real (service query, sem índice além da PK) encontrou:
 *   - listItems             (inventory.inventory_items, 20 linhas)        ~0,09ms  — tabela não cresce (SKU é cadastro, não histórico); sem ação.
 *   - listLocations         (inventory.locations, 5 linhas)               ~0,05ms  — idem; sem ação.
 *   - listBalancesByItem    (inventory.stock_balances, filtra por item)   ~0,05ms  — cardinalidade travada em item×location (unique constraint), nunca cresce com o tempo mesmo com 1M+ movimentos; sem ação.
 *   - listMaintenanceOrders (inventory.maintenance_orders)                ~121ms   em 1M linhas — dentro da meta, mas Seq Scan puro; indexado por precaução (mesmo padrão da rodada 2).
 *   - listLossCases         (inventory.loss_cases)                        ~145ms   em 1M linhas — dentro da meta, Seq Scan; indexado por precaução.
 *   - listRequisitions      (inventory.requisitions)                      ~116ms   em 1M linhas — dentro da meta, Seq Scan; indexado por precaução.
 *   - listCounts            (inventory.counts)                            ~123ms   em 500k linhas — dentro da meta, Seq Scan; indexado por precaução.
 *   - listSupplierQualifications (procurement.supplier_qualifications)    ~123ms   em 300k linhas — dentro da meta, Bitmap Scan pelo unique(company_id,...); indexado por precaução.
 *   - listPolicies          (procurement.insurance_policies)              ~75ms    em 300k linhas — dentro da meta, Seq Scan; indexado por precaução.
 *   - listAssets            (inventory.assets)                            ~618ms   em 1M linhas — ESTOURA a meta de 300ms (Seq Scan + Sort por name). Corrigido com índice composto.
 *
 * Todas as 9 funções cujas tabelas acumulam histórico (tudo exceto listItems/listLocations/
 * listBalancesByItem, que são cadastro ou têm cardinalidade naturalmente travada) ganham
 * índice composto (company_id, <coluna de ordenação do service>) — mesmo padrão das rodadas
 * 1 e 2 — mesmo as que já estavam dentro da meta, como headroom para "anos de operação"
 * (crescimento contínuo de requisições/contagens/perdas/OS/apólices). Depois do índice,
 * listAssets caiu de Seq Scan+Sort (~618ms) para Index Scan (medido abaixo da meta).
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS assets_company_status_name_idx ON inventory.assets (company_id, status, name)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS maintenance_orders_company_opened_idx ON inventory.maintenance_orders (company_id, opened_at DESC)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS loss_cases_company_created_idx ON inventory.loss_cases (company_id, created_at DESC)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS requisitions_company_created_idx ON inventory.requisitions (company_id, created_at DESC)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS counts_company_created_idx ON inventory.counts (company_id, created_at DESC)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS supplier_qualifications_company_created_idx ON procurement.supplier_qualifications (company_id, created_at DESC)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS insurance_policies_company_created_idx ON procurement.insurance_policies (company_id, created_at DESC)'
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS inventory.assets_company_status_name_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS inventory.maintenance_orders_company_opened_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS inventory.loss_cases_company_created_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS inventory.requisitions_company_created_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS inventory.counts_company_created_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS procurement.supplier_qualifications_company_created_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS procurement.insurance_policies_company_created_idx');
  },
};
