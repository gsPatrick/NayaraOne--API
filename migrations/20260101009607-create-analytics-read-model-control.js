'use strict';

/**
 * Marco 9, demanda M9-D607 (Caderno "Dashboards + BI + Centro de Comando", §14 e Guia §4): controle do worker de read models.
 *
 *  - analytics.rm_applied_events: PK (read_model, source_event_id). O worker insere aqui ANTES de atualizar a projeção, na mesma
 *    transação; a segunda entrega do mesmo evento bate na PK e é ignorada (replay idempotente). Falha no meio desfaz tudo.
 *  - analytics.rm_stale_aggregates: agregado cujo recálculo passou do teto de linhas (analytics.refresh.max_linhas_agregado) e foi
 *    adiado para a janela do job agendado; a linha sai quando o job recalcula.
 *
 * RLS ENABLE + FORCE (leitura pelas GUCs de empresa/grupo; escrita só com app.analytics_writer = 'on'). rm_applied_events não tem
 * política de UPDATE para ninguém (o evento aplicado nunca muda). GRANT ao nayara_runtime só se o role existir.
 * Idempotente. Faixa de migrations do BI: 9604 a 9614.
 */
const SCHEMA = 'analytics';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_TENANT = `(company_id = ${COMPANY_GUC} AND group_id = ${GROUP_GUC})`;
const T = (name) => `"${SCHEMA}"."${name}"`;

async function applyRls(q, table, { update }) {
  await q(`ALTER TABLE ${T(table)} ENABLE ROW LEVEL SECURITY`);
  await q(`ALTER TABLE ${T(table)} FORCE ROW LEVEL SECURITY`);
  for (const name of ['analytics_select', 'analytics_insert', 'analytics_update', 'analytics_delete']) {
    await q(`DROP POLICY IF EXISTS ${name} ON ${T(table)}`);
  }
  await q(`CREATE POLICY analytics_select ON ${T(table)} FOR SELECT USING (${READ_TENANT})`);
  await q(`CREATE POLICY analytics_insert ON ${T(table)} FOR INSERT WITH CHECK (${WRITER_ON} AND ${READ_TENANT})`);
  if (update) await q(`CREATE POLICY analytics_update ON ${T(table)} FOR UPDATE USING (${WRITER_ON} AND ${READ_TENANT}) WITH CHECK (${WRITER_ON} AND ${READ_TENANT})`);
  await q(`CREATE POLICY analytics_delete ON ${T(table)} FOR DELETE USING (${WRITER_ON} AND ${READ_TENANT})`);
}

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await q(`
      CREATE TABLE IF NOT EXISTS ${T('rm_applied_events')} (
        read_model text NOT NULL,
        source_event_id text NOT NULL,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        aggregate_id text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT rm_applied_events_pk PRIMARY KEY (read_model, source_event_id),
        CONSTRAINT rm_applied_events_model_format CHECK (read_model ~ '^rm_[a-z][a-z0-9_]*$')
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS rm_applied_events_company_idx ON ${T('rm_applied_events')} (company_id, read_model, applied_at DESC)`);
    await q(`
      CREATE TABLE IF NOT EXISTS ${T('rm_stale_aggregates')} (
        read_model text NOT NULL,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        aggregate_key text NOT NULL,
        marked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reason text NOT NULL DEFAULT 'ROW_LIMIT',
        CONSTRAINT rm_stale_aggregates_pk PRIMARY KEY (read_model, company_id, aggregate_key),
        CONSTRAINT rm_stale_aggregates_model_format CHECK (read_model ~ '^rm_[a-z][a-z0-9_]*$')
      )
    `);
    await applyRls(q, 'rm_applied_events', { update: false });
    await applyRls(q, 'rm_stale_aggregates', { update: true });
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "${SCHEMA}" TO nayara_runtime;
          GRANT SELECT, INSERT, DELETE ON ${T('rm_applied_events')} TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ${T('rm_stale_aggregates')} TO nayara_runtime;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS ${T('rm_stale_aggregates')}`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS ${T('rm_applied_events')}`);
  },
};
