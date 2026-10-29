'use strict';

/**
 * Marco 9, demanda M9-D609 (3.3, snapshot diário): analytics.snapshot_job_runs, o diário do job analyticsSnapshotJob.
 * Uma linha por (empresa, data-base): o job reivindica o dia inserindo a linha (a unicidade faz o segundo job simultâneo ignorar o dia),
 * grava os snapshots das métricas PUBLISHED e fecha a linha com as contagens. `captured_late` marca o dia gravado em catch-up (job parado).
 * Dia com falha de alguma métrica fica PARTIAL e é refeito na passada seguinte (só o que falta: snapshot existente nunca é regravado).
 *
 * RLS ENABLE + FORCE (leitura pelas GUCs de empresa e grupo; escrita só com app.analytics_writer = 'on'). GRANT ao nayara_runtime
 * dentro de guarda de existência do role. SQL puro e idempotente. Faixa reservada: 9752 a 9759.
 */
const SCHEMA = 'analytics';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_TENANT = `(company_id = ${COMPANY_GUC} AND group_id = ${GROUP_GUC})`;
const T = (name) => `"${SCHEMA}"."${name}"`;

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[base]] = await q("SELECT to_regclass('analytics.metric_snapshots') IS NOT NULL AS ok");
    if (!base.ok) throw new Error('Aplique antes a migration 20260101009600 (núcleo de métricas do BI).');
    await q(`
      CREATE TABLE IF NOT EXISTS ${T('snapshot_job_runs')} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        as_of_date date NOT NULL,
        status text NOT NULL DEFAULT 'RUNNING',
        captured_late boolean NOT NULL DEFAULT false,
        metrics_total integer NOT NULL DEFAULT 0,
        snapshots_written integer NOT NULL DEFAULT 0,
        snapshots_existing integer NOT NULL DEFAULT 0,
        metrics_without_provider integer NOT NULL DEFAULT 0,
        metrics_without_source integer NOT NULL DEFAULT 0,
        metrics_failed integer NOT NULL DEFAULT 0,
        started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT snapshot_job_runs_day_uq UNIQUE (company_id, as_of_date),
        CONSTRAINT snapshot_job_runs_status_valid CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL')),
        CONSTRAINT snapshot_job_runs_counts_nonneg CHECK (metrics_total >= 0 AND snapshots_written >= 0 AND snapshots_existing >= 0 AND metrics_without_provider >= 0 AND metrics_without_source >= 0 AND metrics_failed >= 0),
        CONSTRAINT snapshot_job_runs_finished_complete CHECK (status = 'RUNNING' OR finished_at IS NOT NULL)
      )
    `);
    await q(`ALTER TABLE ${T('snapshot_job_runs')} ENABLE ROW LEVEL SECURITY`);
    await q(`ALTER TABLE ${T('snapshot_job_runs')} FORCE ROW LEVEL SECURITY`);
    for (const name of ['analytics_select', 'analytics_insert', 'analytics_update', 'analytics_delete']) {
      await q(`DROP POLICY IF EXISTS ${name} ON ${T('snapshot_job_runs')}`);
    }
    await q(`CREATE POLICY analytics_select ON ${T('snapshot_job_runs')} FOR SELECT USING (${READ_TENANT})`);
    await q(`CREATE POLICY analytics_insert ON ${T('snapshot_job_runs')} FOR INSERT WITH CHECK (${WRITER_ON} AND ${READ_TENANT})`);
    await q(`CREATE POLICY analytics_update ON ${T('snapshot_job_runs')} FOR UPDATE USING (${WRITER_ON} AND ${READ_TENANT}) WITH CHECK (${WRITER_ON} AND ${READ_TENANT})`);
    await q(`CREATE POLICY analytics_delete ON ${T('snapshot_job_runs')} FOR DELETE USING (${WRITER_ON} AND ${READ_TENANT})`);
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "${SCHEMA}" TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ${T('snapshot_job_runs')} TO nayara_runtime;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS ${T('snapshot_job_runs')}`);
  },
};
