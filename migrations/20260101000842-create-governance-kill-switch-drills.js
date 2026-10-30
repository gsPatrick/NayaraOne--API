'use strict';

/**
 * M9-D872 — governance.kill_switch_drills: um registro por teste (drill) de kill switch. A linha nasce RUNNING (com o estado anterior do switch, gravado ANTES do efeito, para
 * a execução seguinte restaurar se o job cair no meio) e termina PASS ou FAIL com a evidência. `environment` (PROD, HOMOLOG, DEV) e `probe_version` permitem que o PASS de
 * HOMOLOG/DEV da mesma versão do probe valha para o switch de PROD. RLS + FORCE pela empresa (função do alicerce, GRANT guardado por existência do role).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.kill_switch_drills (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        flag_id uuid NOT NULL,
        flag_key varchar(128) NOT NULL,
        executed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at timestamptz NULL,
        environment varchar(8) NOT NULL,
        previous_state boolean NOT NULL,
        probe_version varchar(32) NOT NULL,
        result varchar(8) NOT NULL DEFAULT 'RUNNING',
        evidence jsonb NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_kill_drills_env_chk CHECK (environment IN ('PROD','HOMOLOG','DEV')),
        CONSTRAINT gov_kill_drills_result_chk CHECK (result IN ('RUNNING','PASS','FAIL'))
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_kill_drills_flag_idx ON governance.kill_switch_drills (company_id, flag_key, executed_at DESC)');
      await q("SELECT governance.apply_tenant_rls('governance.kill_switch_drills'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.kill_switch_drills');
  },
};
