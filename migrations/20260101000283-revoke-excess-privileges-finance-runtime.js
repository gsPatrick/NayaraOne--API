'use strict';

/**
 * BUG CRÍTICO ENCONTRADO (auditoria E2E ao vivo, Marco 6, Ciclo 6 de RLS, 2026-10-06): mesmo
 * problema já corrigido em `construction` (migration 20260101000282) existia também em TODO o
 * schema `finance` — `nayara_runtime` tinha TRUNCATE/TRIGGER/REFERENCES excedentes nas 27
 * tabelas do schema, incluindo `financial_entries` (usada diretamente pelos lançamentos
 * financeiros gerados por Marco 6 — medição aprovada, resolução de garantia, three-way-match de
 * compras). Mesma causa raiz provável (GRANT ALL aplicado manualmente em algum momento) e mesma
 * violação de privilégio mínimo (IAM-003). Revoga os 3 privilégios excedentes, mantendo só
 * SELECT/INSERT/UPDATE/DELETE.
 */
const AFFECTED_TABLES = [
  'approval_requests', 'approval_steps', 'bank_accounts', 'bank_payment_provider_routing',
  'bank_transactions', 'billing_schedule_items', 'billing_schedules', 'chart_of_accounts',
  'collection_cases', 'commission_installments', 'commissions', 'cost_centers',
  'financial_entries', 'guaranteed_rent_contracts', 'intercompany_transfers', 'owner_repasses',
  'ownership_transfer_tasks', 'payment_intents', 'period_closures', 'reconciliations',
  'rent_adjustments', 'rent_advances', 'result_centers', 'tax_documents', 'utility_accounts',
  'utility_obligations', 'utility_reimbursements',
];

module.exports = {
  async up(queryInterface) {
    for (const table of AFFECTED_TABLES) {
      await queryInterface.sequelize.query(
        `REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE "finance"."${table}" FROM nayara_runtime;`
      );
    }
  },

  async down(queryInterface) {
    for (const table of AFFECTED_TABLES) {
      await queryInterface.sequelize.query(
        `GRANT TRUNCATE, TRIGGER, REFERENCES ON TABLE "finance"."${table}" TO nayara_runtime;`
      );
    }
  },
};
