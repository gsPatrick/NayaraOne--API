'use strict';

/**
 * M9-D900 — governance.mig_runs: uma execução da migração (POST /migration/runs). QUEUED -> RUNNING -> SUCCEEDED | FAILED. Acrescenta a FK de
 * core.external_refs.migration_run_id (M9-D906) para esta tabela. `kind` (RUN ou REPLAY, reabertura N3) nasce aqui nos bancos novos; nos já migrados a migration 863 o acrescenta. RLS + FORCE pela função do alicerce. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.mig_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        kind varchar(8) NOT NULL DEFAULT 'RUN',
        status varchar(12) NOT NULL DEFAULT 'QUEUED',
        source_system varchar(40) NULL,
        entity varchar(30) NULL,
        last_delta boolean NOT NULL DEFAULT false,
        requested_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        started_at timestamptz NULL,
        finished_at timestamptz NULL,
        summary jsonb NULL,
        error text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT mig_runs_kind_chk CHECK (kind IN ('RUN', 'REPLAY')),
        CONSTRAINT mig_runs_status_chk CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'))
      )`);
      await q('CREATE INDEX IF NOT EXISTS mig_runs_queue_idx ON governance.mig_runs (company_id, status, created_at)');
      await q("SELECT governance.apply_tenant_rls('governance.mig_runs'::regclass)");
      await q(`DO $do$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'core_extref_run_fk') THEN
          ALTER TABLE core.external_refs ADD CONSTRAINT core_extref_run_fk FOREIGN KEY (migration_run_id) REFERENCES governance.mig_runs(id) ON UPDATE CASCADE ON DELETE RESTRICT;
        END IF;
      END $do$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS core.external_refs DROP CONSTRAINT IF EXISTS core_extref_run_fk');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.mig_runs');
  },
};
