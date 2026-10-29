'use strict';

/**
 * Apoio das migrations dos read models do BI (schema analytics, M9-D618 e M9-D619): cria a tabela com as colunas comuns
 * (company_id, group_id, source_snapshot_at, refreshed_at, version), a chave primária da empresa, RLS ENABLE + FORCE com as quatro
 * políticas da família analytics (leitura pelas GUCs de empresa e grupo; escrita só com app.analytics_writer = 'on', o worker de
 * read models da M9-D607) e o GRANT ao nayara_runtime dentro de guarda de existência do role.
 */
const SCHEMA = 'analytics';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_TENANT = `(company_id = ${COMPANY_GUC} AND group_id = ${GROUP_GUC})`;
const T = (name) => `"${SCHEMA}"."${name}"`;

const MONEY = (name, { nullable = false } = {}) => `${name} numeric(18,2)${nullable ? '' : ' NOT NULL DEFAULT 0'}`;
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

/** table = { name, columns: ['coluna tipo ...'], key: ['project_id', ...] } — a chave primária é (company_id, ...key). */
async function createReadModelTable(q, { name, columns, key }) {
  await q(`
    CREATE TABLE IF NOT EXISTS ${T(name)} (
      company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      ${columns.join(',\n      ')},
      source_snapshot_at timestamptz,
      refreshed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
      CONSTRAINT ${name}_pk PRIMARY KEY (company_id, ${key.join(', ')})
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS ${name}_group_idx ON ${T(name)} (group_id)`);
  await applyRls(q, name);
}

async function grantRuntime(q, names) {
  await q(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        GRANT USAGE ON SCHEMA "${SCHEMA}" TO nayara_runtime;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ${names.map(T).join(', ')} TO nayara_runtime;
      END IF;
    END $$;
  `);
}

async function dropTables(q, names) {
  for (const name of names) await q(`DROP TABLE IF EXISTS ${T(name)}`);
}

module.exports = { MONEY, COUNT, createReadModelTable, grantRuntime, dropTables };
