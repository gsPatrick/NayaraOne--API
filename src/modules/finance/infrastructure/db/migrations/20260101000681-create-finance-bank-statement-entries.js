'use strict';

/**
 * Marco 9, M9-D237 — lançamentos importados do extrato bancário e conciliação do pagamento.
 *  - finance.bank_statement_entries: uma linha por lançamento do extrato lido do banco por cursor (stream bank.statement). UNIQUE (connection_id, entry_id): reimportar o mesmo
 *    extrato não duplica lançamento (o id do lançamento é do banco). `reconciliation_status`: PENDING (ainda não casou), RECONCILED (casou com um pagamento: o valor confere
 *    em centavos) ou MISMATCH (casou pelo id externo, mas o valor diverge). RLS ENABLE + FORCE.
 *  - finance.payment_intents.reconciled_at / reconciled_entry_id: o pagamento está "conciliado" no Financeiro (a entrada do extrato confere). Não muda o estado da intenção.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE TABLE IF NOT EXISTS "finance"."bank_statement_entries" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        connection_id uuid NOT NULL REFERENCES "integration"."connections"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        entry_id varchar(128) NOT NULL,
        direction varchar(3) NOT NULL CHECK (direction IN ('IN', 'OUT')),
        amount numeric(18,2) NOT NULL CHECK (amount >= 0),
        booked_at timestamptz NOT NULL,
        description text,
        payee_name varchar(200),
        external_payment_id varchar(160),
        reconciliation_status varchar(12) NOT NULL DEFAULT 'PENDING' CHECK (reconciliation_status IN ('PENDING', 'RECONCILED', 'MISMATCH')),
        payment_intent_id uuid,
        reconciled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q('CREATE UNIQUE INDEX IF NOT EXISTS bank_statement_entries_conn_entry_uidx ON "finance"."bank_statement_entries" (connection_id, entry_id);');
    await q('CREATE INDEX IF NOT EXISTS bank_statement_entries_pending_idx ON "finance"."bank_statement_entries" (company_id, reconciliation_status, booked_at);');
    await q('CREATE INDEX IF NOT EXISTS bank_statement_entries_external_idx ON "finance"."bank_statement_entries" (company_id, external_payment_id) WHERE external_payment_id IS NOT NULL;');
    await q('ALTER TABLE "finance"."bank_statement_entries" ENABLE ROW LEVEL SECURITY;');
    await q(`DO $p$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'tenant_isolation' AND polrelid = '"finance"."bank_statement_entries"'::regclass) THEN
        CREATE POLICY tenant_isolation ON "finance"."bank_statement_entries"
          USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
          WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
      END IF;
    END $p$;`);
    await q('ALTER TABLE "finance"."bank_statement_entries" FORCE ROW LEVEL SECURITY;');
    await q('ALTER TABLE "finance"."payment_intents" ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;');
    await q('ALTER TABLE "finance"."payment_intents" ADD COLUMN IF NOT EXISTS reconciled_entry_id uuid;');
    await q(`DO $g$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON "finance"."bank_statement_entries" TO nayara_runtime;
      END IF;
    END $g$;`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "finance"."payment_intents" DROP COLUMN IF EXISTS reconciled_entry_id;');
    await q('ALTER TABLE "finance"."payment_intents" DROP COLUMN IF EXISTS reconciled_at;');
    await q('DROP TABLE IF EXISTS "finance"."bank_statement_entries";');
  },
};
