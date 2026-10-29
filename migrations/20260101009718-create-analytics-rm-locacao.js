'use strict';

/**
 * Marco 9, demanda M9-D617 (Caderno "Dashboards + BI + Centro de Comando", §8 KPIs Locação): read models no schema analytics, todos com
 * company_id/group_id, source_snapshot_at, refreshed_at e version (M9-D607), sem nome nem documento de pessoa (só ids e agregados).
 *  - rm_rental_contracts: contratos de locação por situação (quantidade e valor do contrato).
 *  - rm_rental_vacancy, rm_rental_arrears, rm_rental_inspections_keys, rm_rental_tickets, rm_rental_repasses: um retrato por empresa e data-base.
 *  - rm_rental_guarantees: garantias por tipo (vencendo em 30 e 60 dias, vencidas). rm_rental_obligations: obrigações por tipo (pendentes, vencidas).
 *  - rm_rental_satisfaction: respostas e soma das notas por mês.
 *
 * RLS ENABLE + FORCE: leitura pelas GUCs de empresa/grupo; escrita só com app.analytics_writer = 'on' (worker de read models, M9-D607).
 * GRANT ao nayara_runtime só se o role existir. Idempotente. Faixa reservada: 9717 a 9724.
 */
const SCHEMA = 'analytics';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_TENANT = `(company_id = ${COMPANY_GUC} AND group_id = ${GROUP_GUC})`;
const T = (name) => `"${SCHEMA}"."${name}"`;
const COUNT = (name) => `"${name}" integer NOT NULL DEFAULT 0 CHECK ("${name}" >= 0)`;
const BIG = (name) => `"${name}" bigint NOT NULL DEFAULT 0 CHECK ("${name}" >= 0)`;
const MONEY = (name) => `"${name}" numeric(18,2) NOT NULL DEFAULT 0`;
const MONTH = (name) => `"${name}" varchar(7) NOT NULL CHECK ("${name}" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')`;

const COMMON = `
  source_snapshot_at timestamptz,
  refreshed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1)`;

// [tabela, colunas da chave (DDL), nomes da chave, colunas de valor (DDL)]
const TABLES = [
  ['rm_rental_contracts', ['status varchar(32) NOT NULL'], ['status'], [COUNT('count'), MONEY('rent_total')]],
  ['rm_rental_vacancy', ['as_of_date date NOT NULL'], ['as_of_date'], [COUNT('rentable_total'), COUNT('rented_total'), COUNT('suspended_total'), COUNT('vacant_total'), BIG('vacant_days_sum')]],
  ['rm_rental_arrears', ['as_of_date date NOT NULL'], ['as_of_date'], [MONEY('billed_90d'), MONEY('overdue_amount'), MONEY('overdue_amount_in_window_90d'), MONEY('overdue_amount_outside_window_90d'), COUNT('overdue_count')]],
  ['rm_rental_guarantees', ['type varchar(32) NOT NULL'], ['type'], [COUNT('expiring_30d'), COUNT('expiring_60d'), COUNT('expired')]],
  ['rm_rental_obligations', ['kind varchar(32) NOT NULL'], ['kind'], [COUNT('pending'), COUNT('overdue')]],
  ['rm_rental_inspections_keys', ['as_of_date date NOT NULL'], ['as_of_date'], [COUNT('inspections_pending'), COUNT('inspections_done'), COUNT('keys_out'), COUNT('keys_overdue')]],
  ['rm_rental_tickets', ['as_of_date date NOT NULL'], ['as_of_date'], [COUNT('opened'), COUNT('closed'), COUNT('open_total'), MONEY('resolution_hours_sum')]],
  ['rm_rental_satisfaction', [MONTH('month')], ['month'], [COUNT('responses'), 'score_sum integer NOT NULL DEFAULT 0']],
  ['rm_rental_repasses', ['as_of_date date NOT NULL'], ['as_of_date'], [MONEY('pending'), MONEY('paid'), MONEY('overdue'), COUNT('pending_count'), COUNT('paid_count'), COUNT('overdue_count')]],
];

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

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    for (const [table, keyDdl, keyNames, valueDdl] of TABLES) {
      await q(`
        CREATE TABLE IF NOT EXISTS ${T(table)} (
          company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          ${[...keyDdl, ...valueDdl].join(',\n          ')},
          ${COMMON},
          CONSTRAINT ${table}_pk PRIMARY KEY (company_id, ${keyNames.map((n) => `"${n}"`).join(', ')})
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS ${table}_group_idx ON ${T(table)} (group_id)`);
      await applyRls(q, table);
    }
    const names = TABLES.map(([table]) => T(table)).join(', ');
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "${SCHEMA}" TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ${names} TO nayara_runtime;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    for (const [table] of [...TABLES].reverse()) await queryInterface.sequelize.query(`DROP TABLE IF EXISTS ${T(table)}`);
  },
};
