'use strict';

/**
 * M9-D911 — governance.retention_runs: o relatório da simulação (DRY) e a execução real sobre ele. A simulação nasce DRY_DONE e não altera nenhum dado; o apply
 * parte dela (APPLYING, depois APPLIED ou FAILED; FAILED é retomado nos lotes pendentes). reference_date é o "hoje" da simulação, para o apply reproduzir o mesmo conjunto.
 * report guarda, por política, as contagens e a amostra de chaves. RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.retention_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        mode varchar(5) NOT NULL DEFAULT 'DRY',
        source varchar(10) NOT NULL DEFAULT 'API',
        status varchar(10) NOT NULL DEFAULT 'DRY_DONE',
        reference_date date NOT NULL,
        batch_size integer NOT NULL,
        policy_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
        report jsonb NOT NULL DEFAULT '{}'::jsonb,
        apply_summary jsonb NULL,
        error_message text NULL,
        created_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        applied_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        applied_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_ret_run_mode_chk CHECK (mode IN ('DRY', 'APPLY')),
        CONSTRAINT gov_ret_run_source_chk CHECK (source IN ('API', 'JOB', 'JOB_AUTO')),
        CONSTRAINT gov_ret_run_status_chk CHECK (status IN ('DRY_DONE', 'APPLYING', 'APPLIED', 'FAILED')),
        CONSTRAINT gov_ret_run_batch_chk CHECK (batch_size > 0)
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_ret_run_list_idx ON governance.retention_runs (company_id, created_at DESC)');
      await q("SELECT governance.apply_tenant_rls('governance.retention_runs'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.retention_runs');
  },
};
