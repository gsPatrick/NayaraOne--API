'use strict';

/**
 * M9-D907 — governance.external_op_log: cada operação externa feita no sistema novo a partir de T0 (o GO). Gravada na MESMA transação do envio (`dispatch_id`, único por empresa); sem o registro o envio não sai.
 * RLS + FORCE pela função do alicerce; GRANT ao runtime dentro de guarda de existência do papel. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.external_op_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        type_id uuid NOT NULL,
        op_type varchar(64) NOT NULL,
        reference varchar(128) NOT NULL,
        executed_at timestamptz NOT NULL DEFAULT now(),
        entity varchar(64) NULL,
        amount_cents bigint NULL,
        dispatch_id uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT external_op_log_type_fk FOREIGN KEY (company_id, type_id) REFERENCES governance.external_op_types (company_id, id) ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT external_op_log_amount_chk CHECK (amount_cents IS NULL OR amount_cents >= 0)
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS external_op_log_dispatch_uq ON governance.external_op_log (company_id, dispatch_id) WHERE dispatch_id IS NOT NULL');
      await q('CREATE INDEX IF NOT EXISTS external_op_log_executed_idx ON governance.external_op_log (company_id, executed_at)');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS external_op_log_id_company_uq ON governance.external_op_log (company_id, id)');
      await q("SELECT governance.apply_tenant_rls('governance.external_op_log'::regclass)");
      await q(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON governance.external_op_log TO nayara_runtime;
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.external_op_log');
  },
};
