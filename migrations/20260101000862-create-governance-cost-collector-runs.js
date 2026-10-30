'use strict';

/**
 * M9-D860 — governance.cost_collector_runs: uma linha por coletor e empresa com o último sucesso e a última falha (código GOV_FINOPS_COLLECTOR_FAILED).
 * Coletor que falha NÃO grava valor: só atualiza esta linha, e a consulta mostra o último sucesso. RLS + FORCE pela empresa.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.cost_collector_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        collector varchar(20) NOT NULL,
        last_status varchar(7) NOT NULL,
        last_run_at timestamptz NOT NULL,
        last_success_at timestamptz NULL,
        last_success_lines integer NULL,
        last_failure_at timestamptz NULL,
        last_error_code varchar(60) NULL,
        last_error_message text NULL,
        consecutive_failures integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_cost_runs_status_chk CHECK (last_status IN ('OK', 'FAILED')),
        CONSTRAINT gov_cost_runs_key_uq UNIQUE (company_id, collector)
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.cost_collector_runs'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.cost_collector_runs');
  },
};
