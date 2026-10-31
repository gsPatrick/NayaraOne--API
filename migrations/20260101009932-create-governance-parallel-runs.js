'use strict';

/**
 * M9-D903 — governance.parallel_runs: uma execução do comparador por janela, numerada (janela, número) e única. No máximo uma RUNNING por janela (índice único parcial): é
 * o que impede duas instâncias do job de comparar a mesma janela ao mesmo tempo. Execução que não terminou fica FAILED e nunca conta como "sem diferenças". RLS + FORCE. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.parallel_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        window_id uuid NOT NULL REFERENCES governance.parallel_windows(id) ON UPDATE CASCADE ON DELETE CASCADE,
        run_number integer NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'RUNNING',
        error_code varchar(60) NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz NULL,
        summary jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT parallel_runs_status_chk CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
        CONSTRAINT parallel_runs_number_uq UNIQUE (window_id, run_number)
      )`);
      await q("CREATE UNIQUE INDEX IF NOT EXISTS parallel_runs_one_running_uq ON governance.parallel_runs (window_id) WHERE status = 'RUNNING'");
      await q("SELECT governance.apply_tenant_rls('governance.parallel_runs'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.parallel_runs');
  },
};
