'use strict';

/**
 * M9-D908 §3.1 — governance.mig_clock_checks: cada conferência de relógio (aplicação, banco de destino, NTP e fonte antiga) com a leitura de cada sistema, a deriva medida e o
 * limite vigente na hora. A conferência mais recente da empresa é a que abre ou fecha o blocker GOV_MIG_CLOCK_DRIFT da Torre. Só se acrescenta. RLS + FORCE pela função do alicerce;
 * GRANT ao runtime dentro de guarda de existência do papel. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.mig_clock_checks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        context varchar(12) NOT NULL,
        run_id uuid NULL,
        dry_run_id uuid NULL,
        readings jsonb NOT NULL DEFAULT '[]'::jsonb,
        drift_ms integer NULL,
        max_drift_ms integer NOT NULL,
        status varchar(12) NOT NULL,
        checked_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT mig_clock_checks_status_chk CHECK (status IN ('OK', 'DRIFT', 'UNMEASURED')),
        CONSTRAINT mig_clock_checks_context_chk CHECK (context IN ('BATCH', 'DRY3', 'RECHECK', 'MANUAL'))
      )`);
      await q('CREATE INDEX IF NOT EXISTS mig_clock_checks_latest_idx ON governance.mig_clock_checks (company_id, checked_at DESC)');
      await q("SELECT governance.apply_tenant_rls('governance.mig_clock_checks'::regclass)");
      await q(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON governance.mig_clock_checks TO nayara_runtime;
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.mig_clock_checks');
  },
};
