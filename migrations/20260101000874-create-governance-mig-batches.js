'use strict';

/**
 * M9-D900 — governance.mig_batches: o lote e o seu estado (decisão K8: PLANNED, RUNNING, APPLIED, VERIFIED, HASH_MISMATCH, FAILED, ABORTED; as transições valem no serviço
 * batch.states). `from_token`/`to_token` delimitam o intervalo (posição do CDC, par data|chave do watermark ou chave do FULL_DIFF); `replay_of` aponta o lote original de um
 * replay, que nunca muda de estado. Um único lote RUNNING por fonte (índice parcial: o segundo recebe GOV_MIG_BATCH_RUNNING). `root_hash` é o resumo do lote (M9-D905 o refina).
 * RLS + FORCE pela função do alicerce. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.mig_batches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        run_id uuid NOT NULL REFERENCES governance.mig_runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        source_id uuid NOT NULL REFERENCES governance.mig_sources(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        source_system varchar(40) NOT NULL,
        entity varchar(30) NOT NULL,
        from_token text NULL,
        to_token text NULL,
        row_count integer NOT NULL DEFAULT 0,
        status varchar(14) NOT NULL DEFAULT 'PLANNED',
        attempts integer NOT NULL DEFAULT 0,
        replay_of uuid NULL REFERENCES governance.mig_batches(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        started_at timestamptz NULL,
        finished_at timestamptz NULL,
        root_hash char(64) NULL,
        error text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT mig_batches_status_chk CHECK (status IN ('PLANNED', 'RUNNING', 'APPLIED', 'VERIFIED', 'HASH_MISMATCH', 'FAILED', 'ABORTED'))
      )`);
      await q("CREATE UNIQUE INDEX IF NOT EXISTS mig_batches_running_uq ON governance.mig_batches (source_id) WHERE status = 'RUNNING'");
      await q('CREATE INDEX IF NOT EXISTS mig_batches_run_idx ON governance.mig_batches (company_id, run_id, created_at)');
      await q('CREATE INDEX IF NOT EXISTS mig_batches_source_idx ON governance.mig_batches (source_id, created_at)');
      await q("SELECT governance.apply_tenant_rls('governance.mig_batches'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.mig_batches');
  },
};
