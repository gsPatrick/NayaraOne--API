'use strict';

/**
 * Marco 9, demanda M9-D708 (Caderno §23, "PRONTO PARA LAB; produção exige reconciliação de KPIs com relatórios-fonte e aceite dos owners"):
 * analytics.metric_acceptance, a reconciliação de cada KPI com o relatório de referência e o aceite (ou a rejeição) do owner.
 *
 * Uma linha por empresa, código e VERSÃO da métrica (nova versão = nova linha PENDING; a linha da versão anterior fica como histórico).
 * `difference` = valor do BI menos o valor do relatório; `tolerance` é a vigente quando a linha foi calculada (parâmetro analytics.aceite.tolerancia).
 * RLS ENABLE + FORCE: leitura pelas GUCs de empresa e grupo; escrita só com app.analytics_writer = 'on' (o serviço do BI). SEM política de DELETE
 * (o histórico do aceite não se apaga) e o papel de execução não recebe DELETE. GRANT ao nayara_runtime dentro de guarda de existência do role.
 * SQL puro, idempotente e reversível. Faixa reservada: 9926 a 9933.
 */
const SCHEMA = 'analytics';
const TABLE = 'metric_acceptance';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_TENANT = `(company_id = ${COMPANY_GUC} AND group_id = ${GROUP_GUC})`;
const T = `"${SCHEMA}"."${TABLE}"`;

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[base]] = await q("SELECT to_regclass('analytics.metric_definitions') IS NOT NULL AS ok");
    if (!base.ok) throw new Error('Aplique antes a migration 20260101009600 (núcleo de métricas do BI).');
    await q(`
      CREATE TABLE IF NOT EXISTS ${T} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        metric_code text NOT NULL,
        metric_version integer NOT NULL,
        owner_user_id uuid NULL,
        reference_report text NULL,
        reference_value numeric(20,4) NULL,
        bi_value numeric(20,4) NULL,
        difference numeric(20,4) NULL,
        tolerance numeric(20,4) NULL,
        evidence_file_id uuid NULL,
        status text NOT NULL DEFAULT 'PENDING',
        accepted_by uuid NULL,
        accepted_at timestamptz NULL,
        comment text NULL,
        reconciled_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT metric_acceptance_version_uq UNIQUE (company_id, metric_code, metric_version),
        CONSTRAINT metric_acceptance_status_valid CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
        CONSTRAINT metric_acceptance_version_positive CHECK (metric_version >= 1),
        CONSTRAINT metric_acceptance_code_format CHECK (metric_code ~ '^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$'),
        CONSTRAINT metric_acceptance_tolerance_nonneg CHECK (tolerance IS NULL OR tolerance >= 0),
        CONSTRAINT metric_acceptance_decided_complete CHECK (status = 'PENDING' OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL AND evidence_file_id IS NOT NULL))
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS metric_acceptance_status_idx ON ${T} (company_id, status)`);
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
