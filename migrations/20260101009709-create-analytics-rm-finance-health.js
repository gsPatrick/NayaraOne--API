'use strict';

/**
 * Marco 9, demanda M9-D615 (Caderno "Dashboards + BI + Centro de Comando", Guia §5 FinanceHealthReadModel): read models do Financeiro no
 * schema analytics, uma linha por empresa e data-base (saúde) e uma por empresa, centro de resultado e mês de competência (margem).
 *
 *  - analytics.rm_finance_health: o estado já somado do painel Financeiro. Guarda os COMPONENTES (não só o resultado) e os critérios que
 *    reproduzem cada componente (source_criteria, M9-D611 3.3), nunca nome nem documento de pessoa.
 *  - analytics.rm_finance_sector_margin: receita e custo realizados por setor (centro de resultado) e competência; o "sem setor" usa o
 *    UUID zero (chave sempre preenchida, sem NULL na chave única).
 *
 * RLS ENABLE + FORCE: leitura pelas GUCs de empresa/grupo; escrita só com app.analytics_writer = 'on' (worker de read models, M9-D607).
 * GRANT ao nayara_runtime só se o role existir. Idempotente. Faixa reservada: 9709 a 9716.
 */
const SCHEMA = 'analytics';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_TENANT = `(company_id = ${COMPANY_GUC} AND group_id = ${GROUP_GUC})`;
const T = (name) => `"${SCHEMA}"."${name}"`;
const MONEY = (name) => `${name} numeric(18,2) NOT NULL DEFAULT 0`;
const COUNT = (name) => `${name} integer NOT NULL DEFAULT 0 CHECK (${name} >= 0)`;

async function applyRls(q, table) {
  await q(`ALTER TABLE ${T(table)} ENABLE ROW LEVEL SECURITY`);
  await q(`ALTER TABLE ${T(table)} FORCE ROW LEVEL SECURITY`);
  for (const name of ['analytics_select', 'analytics_insert', 'analytics_update', 'analytics_delete']) {
    await q(`DROP POLICY IF EXISTS ${name} ON ${T(table)}`);
  }
  await q(`CREATE POLICY analytics_select ON ${T(table)} FOR SELECT USING (${READ_TENANT})`);
  await q(`CREATE POLICY analytics_insert ON ${T(table)} FOR INSERT WITH CHECK (${WRITER_ON} AND ${READ_TENANT})`);
  await q(`CREATE POLICY analytics_update ON ${T(table)} FOR UPDATE USING (${WRITER_ON} AND ${READ_TENANT}) WITH CHECK (${WRITER_ON} AND ${READ_TENANT})`);
  await q(`CREATE POLICY analytics_delete ON ${T(table)} FOR DELETE USING (${WRITER_ON} AND ${READ_TENANT})`);
}

const COMMON = `
  source_snapshot_at timestamptz,
  refreshed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1)`;

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await q(`
      CREATE TABLE IF NOT EXISTS ${T('rm_finance_health')} (
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        as_of_date date NOT NULL,
        ${['free_cash', 'third_party_cash', 'payables_7d', 'payables_30d', 'payables_60d', 'receivables_7d', 'receivables_30d', 'receivables_60d',
    'overdue_payables', 'overdue_amount', 'overdue_amount_in_window_90d', 'overdue_amount_outside_window_90d', 'receivables_base_90d',
    'pending_owner_repasses', 'provisioned_commissions', 'paid_commissions', 'commissions_unlinked_30d', 'breathing_need'].map(MONEY).join(',\n        ')},
        ${['pending_reconciliations', 'open_anomalies', 'entries_without_due_date'].map(COUNT).join(',\n        ')},
        source_criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
        ${COMMON},
        CONSTRAINT rm_finance_health_pk PRIMARY KEY (company_id, as_of_date)
      )
    `);
    await q(`
      CREATE TABLE IF NOT EXISTS ${T('rm_finance_sector_margin')} (
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        result_center_id uuid NOT NULL,
        competence_month varchar(7) NOT NULL CHECK (competence_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        ${['revenue_actual', 'cost_actual'].map(MONEY).join(',\n        ')},
        ${COMMON},
        CONSTRAINT rm_finance_sector_margin_pk PRIMARY KEY (company_id, result_center_id, competence_month)
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS rm_finance_health_group_idx ON ${T('rm_finance_health')} (group_id, as_of_date DESC)`);
    await q(`CREATE INDEX IF NOT EXISTS rm_finance_sector_margin_group_idx ON ${T('rm_finance_sector_margin')} (group_id, competence_month)`);
    await applyRls(q, 'rm_finance_health');
    await applyRls(q, 'rm_finance_sector_margin');
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "${SCHEMA}" TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ${T('rm_finance_health')}, ${T('rm_finance_sector_margin')} TO nayara_runtime;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS ${T('rm_finance_sector_margin')}`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS ${T('rm_finance_health')}`);
  },
};
