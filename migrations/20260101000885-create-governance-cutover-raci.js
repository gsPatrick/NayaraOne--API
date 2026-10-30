'use strict';

/**
 * M9-D902 — RACI de cutover por atividade. governance.cutover_activities (código fixo, título, ordem, fase PRE|CUTOVER|POST) e governance.cutover_raci (atividade, usuário OU perfil, R|A|C|I).
 * Índice único parcial: no máximo UM "A" por atividade (o segundo é recusado com 422 pelo serviço e, na corrida, pelo banco). RLS + FORCE pela função do alicerce. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.cutover_activities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        code varchar(40) NOT NULL,
        title varchar(160) NOT NULL,
        sort_order integer NOT NULL,
        phase varchar(10) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT cutover_activities_phase_chk CHECK (phase IN ('PRE', 'CUTOVER', 'POST')),
        CONSTRAINT cutover_activities_code_uq UNIQUE (company_id, code)
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.cutover_activities'::regclass)");
      await q(`CREATE TABLE IF NOT EXISTS governance.cutover_raci (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        activity_code varchar(40) NOT NULL,
        user_id uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
        role varchar(80) NULL,
        raci char(1) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT cutover_raci_value_chk CHECK (raci IN ('R', 'A', 'C', 'I')),
        CONSTRAINT cutover_raci_who_chk CHECK (num_nonnulls(user_id, role) = 1),
        CONSTRAINT cutover_raci_activity_fk FOREIGN KEY (company_id, activity_code) REFERENCES governance.cutover_activities (company_id, code) ON UPDATE CASCADE ON DELETE CASCADE
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS cutover_raci_single_a_uq ON governance.cutover_raci (company_id, activity_code) WHERE raci = \'A\'');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS cutover_raci_entry_uq ON governance.cutover_raci (company_id, activity_code, raci, COALESCE(user_id::text, \'\'), COALESCE(upper(role), \'\'))');
      await q("SELECT governance.apply_tenant_rls('governance.cutover_raci'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.cutover_raci');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.cutover_activities');
  },
};
