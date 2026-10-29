'use strict';

/**
 * M9-D833 — governance.manual_operation_checks: as duas conferências do pagamento manual emergencial. `role` CHECKER_1 (quem registrou a operação) ou CHECKER_2 (quem a
 * importou, com governance:bcp:approve); uma linha por papel e operação; `at` é a data e a hora da conferência. RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.manual_operation_checks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        manual_operation_id uuid NOT NULL REFERENCES governance.manual_operations(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        role varchar(10) NOT NULL,
        user_id uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_manual_check_role_chk CHECK (role IN ('CHECKER_1', 'CHECKER_2')),
        CONSTRAINT gov_manual_check_op_role_uq UNIQUE (manual_operation_id, role)
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.manual_operation_checks'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.manual_operation_checks');
  },
};
