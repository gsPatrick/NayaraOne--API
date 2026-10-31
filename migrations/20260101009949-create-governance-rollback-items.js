'use strict';

/**
 * M9-D907 — governance.rollback_items: um item por operação externa do setor revertido (rollback de setor da M9-D904), COMPENSABLE ou IRREVERSIBLE, desde T0. Estado PENDING_COMPENSATION ou COMPENSATED; `log_id` único (repetir o rollback não duplica).
 * RLS + FORCE pela função do alicerce; GRANT ao runtime dentro de guarda de existência do papel. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.rollback_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        log_id uuid NOT NULL,
        sector varchar(30) NOT NULL,
        state varchar(24) NOT NULL DEFAULT 'PENDING_COMPENSATION',
        resolution_note text NULL,
        compensation_ref varchar(128) NULL,
        resolved_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        resolved_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT rollback_items_state_chk CHECK (state IN ('PENDING_COMPENSATION', 'COMPENSATED')),
        CONSTRAINT rollback_items_log_fk FOREIGN KEY (company_id, log_id) REFERENCES governance.external_op_log (company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT rollback_items_log_uq UNIQUE (company_id, log_id)
      )`);
      await q('CREATE INDEX IF NOT EXISTS rollback_items_state_idx ON governance.rollback_items (company_id, state, sector)');
      await q("SELECT governance.apply_tenant_rls('governance.rollback_items'::regclass)");
      await q(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON governance.rollback_items TO nayara_runtime;
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.rollback_items');
  },
};
