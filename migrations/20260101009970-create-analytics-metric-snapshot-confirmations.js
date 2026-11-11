'use strict';

/**
 * Marco 9, correção do BI de Tecnologia (DI-BI-2, M9-D609): analytics.metric_snapshot_confirmations, a ÚLTIMA vez que um refresh releu a fonte e confirmou que o valor
 * principal de um snapshot continua o mesmo.
 *
 * O snapshot é imutável (M9-D600): quando o recálculo dá o mesmo valor, o mesmo status e o mesmo hash, nada se grava, e o `source_snapshot_at` do snapshot fica no instante
 * do PRIMEIRO cálculo. Sem esta tabela, um indicador que não muda (ex.: zero integrações com erro o dia inteiro) envelhece até EXPIRED e some do painel ("Dado antigo, não use
 * para decidir") mesmo com a fonte relida a cada passada. Uma linha por snapshot (o valor principal, dimensão vazia), atualizada a cada confirmação; o snapshot não muda.
 *
 * RLS ENABLE + FORCE: leitura pelas GUCs de empresa e grupo; escrita só com app.analytics_writer = 'on' (o serviço do BI). Sem política de DELETE (a linha some junto com a
 * empresa). GRANT ao nayara_runtime dentro de guarda de existência do role. SQL puro, idempotente e reversível.
 */
const SCHEMA = 'analytics';
const TABLE = 'metric_snapshot_confirmations';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_TENANT = `(company_id = ${COMPANY_GUC} AND group_id = ${GROUP_GUC})`;
const T = `"${SCHEMA}"."${TABLE}"`;

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[base]] = await q("SELECT to_regclass('analytics.metric_snapshots') IS NOT NULL AS ok");
    if (!base.ok) throw new Error('Aplique antes a migration 20260101009600 (núcleo de métricas do BI).');
    await q(`
      CREATE TABLE IF NOT EXISTS ${T} (
        snapshot_id uuid PRIMARY KEY REFERENCES "${SCHEMA}"."metric_snapshots"(id) ON DELETE CASCADE ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        metric_id uuid NOT NULL,
        source_confirmed_at timestamptz NOT NULL,
        confirmed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        confirmations integer NOT NULL DEFAULT 1,
        CONSTRAINT metric_snapshot_confirmations_count_positive CHECK (confirmations >= 1)
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS metric_snapshot_confirmations_company_idx ON ${T} (company_id, metric_id)`);
    await q(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`);
    await q(`ALTER TABLE ${T} FORCE ROW LEVEL SECURITY`);
    for (const name of ['analytics_select', 'analytics_insert', 'analytics_update', 'analytics_delete']) {
      await q(`DROP POLICY IF EXISTS ${name} ON ${T}`);
    }
    await q(`CREATE POLICY analytics_select ON ${T} FOR SELECT USING (${READ_TENANT})`);
    await q(`CREATE POLICY analytics_insert ON ${T} FOR INSERT WITH CHECK (${WRITER_ON} AND ${READ_TENANT})`);
    await q(`CREATE POLICY analytics_update ON ${T} FOR UPDATE USING (${WRITER_ON} AND ${READ_TENANT}) WITH CHECK (${WRITER_ON} AND ${READ_TENANT})`);
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "${SCHEMA}" TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE ON ${T} TO nayara_runtime;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS ${T}`);
  },
};
