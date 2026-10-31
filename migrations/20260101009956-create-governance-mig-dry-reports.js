'use strict';

/**
 * M9-D908 §3.3 — governance.mig_dry_reports: o relatório do ensaio DRY3 (volume por entidade origem x destino, duração por fase, erros, quarentena, blockers, critérios e a
 * conclusão APROVADO ou REPROVADO calculada pelos critérios). RUNNING -> COMPLETED | ABORTED (ensaio interrompido nunca aprova). No máximo um ensaio RUNNING por empresa.
 * RLS + FORCE pela função do alicerce; GRANT ao runtime dentro de guarda de existência do papel. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.mig_dry_reports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        kind varchar(8) NOT NULL DEFAULT 'DRY3',
        status varchar(10) NOT NULL DEFAULT 'RUNNING',
        conclusion varchar(10) NULL,
        requested_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        commit_hash varchar(64) NULL,
        phases jsonb NOT NULL DEFAULT '[]'::jsonb,
        volumes jsonb NOT NULL DEFAULT '[]'::jsonb,
        criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
        blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
        errors jsonb NOT NULL DEFAULT '[]'::jsonb,
        quarantine jsonb NOT NULL DEFAULT '{}'::jsonb,
        samples jsonb NOT NULL DEFAULT '[]'::jsonb,
        run_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz NULL,
        CONSTRAINT mig_dry_reports_status_chk CHECK (status IN ('RUNNING', 'COMPLETED', 'ABORTED')),
        CONSTRAINT mig_dry_reports_conclusion_chk CHECK (conclusion IS NULL OR conclusion IN ('APROVADO', 'REPROVADO')),
        CONSTRAINT mig_dry_reports_kind_chk CHECK (kind IN ('DRY3')),
        CONSTRAINT mig_dry_reports_concluded_chk CHECK ((status = 'COMPLETED') = (conclusion IS NOT NULL))
      )`);
      await q("CREATE UNIQUE INDEX IF NOT EXISTS mig_dry_reports_one_running_uq ON governance.mig_dry_reports (company_id) WHERE status = 'RUNNING'");
      await q('CREATE INDEX IF NOT EXISTS mig_dry_reports_latest_idx ON governance.mig_dry_reports (company_id, started_at DESC)');
      await q("SELECT governance.apply_tenant_rls('governance.mig_dry_reports'::regclass)");
      await q(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON governance.mig_dry_reports TO nayara_runtime;
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.mig_dry_reports');
  },
};
