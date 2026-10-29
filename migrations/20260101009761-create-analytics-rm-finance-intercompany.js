'use strict';

/**
 * Marco 9, demanda M9-D625 (visão consolidada do grupo, BI-004): read model analytics.rm_finance_intercompany, uma linha por transferência
 * aprovada entre empresas do grupo, pertencente à empresa de ORIGEM (company_id = from_company_id, como finance.intercompany_transfers), com o estado
 * dos dois lados: lançamento de saída na origem, lançamento de entrada no destino, valores, status, vencimento e liquidação, e o estado do par
 * (MATCHED, ONLY_FROM, ONLY_TO ou AMOUNT_MISMATCH). Serve à eliminação do intercompany na LEITURA do consolidado; o ledger nunca recebe linha
 * consolidada. Só ids técnicos, valores e datas (nenhum nome nem documento).
 * RLS ENABLE + FORCE: leitura pelas GUCs de empresa/grupo; escrita só com app.analytics_writer = 'on' (worker de read models, M9-D607).
 * GRANT ao nayara_runtime só se o role existir. Idempotente. Faixa reservada: 9760 a 9767.
 */
const SCHEMA = 'analytics';
const TABLE = 'rm_finance_intercompany';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_TENANT = `(company_id = ${COMPANY_GUC} AND group_id = ${GROUP_GUC})`;
const T = `"${SCHEMA}"."${TABLE}"`;

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await q(`
      CREATE TABLE IF NOT EXISTS ${T} (
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        transfer_id uuid NOT NULL,
        to_company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        amount numeric(18,2) NOT NULL CHECK (amount > 0),
        transfer_status varchar(32) NOT NULL,
        pair_state varchar(20) NOT NULL CHECK (pair_state IN ('MATCHED', 'ONLY_FROM', 'ONLY_TO', 'AMOUNT_MISMATCH')),
        from_entry_id uuid,
        from_entry_status varchar(32),
        from_amount numeric(18,2),
        from_due_at timestamptz,
        from_settled_at timestamptz,
        to_entry_id uuid,
        to_entry_status varchar(32),
        to_amount numeric(18,2),
        to_due_at timestamptz,
        to_settled_at timestamptz,
        source_snapshot_at timestamptz,
        refreshed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        CONSTRAINT rm_finance_intercompany_pk PRIMARY KEY (company_id, transfer_id)
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS rm_finance_intercompany_group_idx ON ${T} (group_id, to_company_id)`);
    await q(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`);
    await q(`ALTER TABLE ${T} FORCE ROW LEVEL SECURITY`);
    for (const name of ['analytics_select', 'analytics_insert', 'analytics_update', 'analytics_delete']) await q(`DROP POLICY IF EXISTS ${name} ON ${T}`);
    await q(`CREATE POLICY analytics_select ON ${T} FOR SELECT USING (${READ_TENANT})`);
    await q(`CREATE POLICY analytics_insert ON ${T} FOR INSERT WITH CHECK (${WRITER_ON} AND ${READ_TENANT})`);
    await q(`CREATE POLICY analytics_update ON ${T} FOR UPDATE USING (${WRITER_ON} AND ${READ_TENANT}) WITH CHECK (${WRITER_ON} AND ${READ_TENANT})`);
    await q(`CREATE POLICY analytics_delete ON ${T} FOR DELETE USING (${WRITER_ON} AND ${READ_TENANT})`);
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "${SCHEMA}" TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ${T} TO nayara_runtime;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS ${T}`);
  },
};
