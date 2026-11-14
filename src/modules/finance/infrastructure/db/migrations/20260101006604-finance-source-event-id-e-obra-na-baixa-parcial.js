'use strict';

const { forceRestaurado } = require('../../../../../shared/db/forceRestaurado');
/**
 * Verificação independente do Marco 6.
 *
 * M6-21 — Caderno Obras §7: "APPROVED gera measurement.approved; consumidor Financeiro cria payable com source_event_id
 * UNIQUE"; Guia §6: "Financeiro usa sourceEventId UNIQUE". finance.financial_entries ganha source_event_id (o id do
 * evento do outbox que originou o lançamento) com índice único. As contas a pagar de medição que já existem (criadas
 * antes do consumidor, com a chave measurement.payable:<medição>) recebem o id do evento measurement.approved da mesma
 * medição, para que a reentrega desse evento ao consumidor encontre a conta e não crie outra.
 *
 * M6-97 — a baixa parcial (lançamento SETTLED filho) não copiava construction_project_id do lançamento original: o
 * relatório por obra sobre movimentos perdia o pagamento parcial. O código passou a copiar (ledger-movement.js); aqui as
 * baixas parciais que já existem recebem a obra do pai.
 *
 * As duas correções de dados são UPDATE em colunas mutáveis do ledger: o gatilho trg_financial_entries_row_change_audit
 * (migration 421) grava cada mudança em audit.audit_log com antes e depois. RLS: NO FORCE só durante a correção (mesmo
 * padrão de 20260101009975). O down remove a coluna; a obra copiada para as baixas parciais fica (é o dado correto).
 */
const NO_FORCE = ['finance.financial_entries', 'integration.outbox_events', 'audit.audit_log'];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE finance.financial_entries ADD COLUMN IF NOT EXISTS source_event_id uuid NULL');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS financial_entries_source_event_unique ON finance.financial_entries (source_event_id) WHERE source_event_id IS NOT NULL');
      for (const t of NO_FORCE) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      await forceRestaurado(async () => {
        await q(`UPDATE finance.financial_entries f SET construction_project_id = p.construction_project_id
                   FROM finance.financial_entries p
                  WHERE f.parent_entry_id = p.id AND f.construction_project_id IS NULL AND p.construction_project_id IS NOT NULL
                    AND f.nature = p.nature`);
        await q(`UPDATE finance.financial_entries f SET source_event_id = e.id
                   FROM integration.outbox_events e
                  WHERE f.source_event_id IS NULL AND f.idempotency_key LIKE 'measurement.payable:%'
                    AND e.company_id = f.company_id AND e.event_type = 'measurement.approved'
                    AND e.idempotency_key = 'measurement.approved:' || substring(f.idempotency_key FROM 21)
                    AND NOT EXISTS (SELECT 1 FROM finance.financial_entries x WHERE x.source_event_id = e.id)`);
      }, async () => {
        for (const t of NO_FORCE) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS finance.financial_entries_source_event_unique');
    await queryInterface.sequelize.query('ALTER TABLE finance.financial_entries DROP COLUMN IF EXISTS source_event_id');
  },
};
