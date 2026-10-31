'use strict';

/**
 * M9-D907 — governance.external_op_types: inventário das operações externas que o rollback não desfaz sozinho (reversibilidade, compensação, procedimento e responsável). `operations` liga o tipo às operações de envio externo (createDispatch); `entity` liga o tipo ao setor do canary.
 * RLS + FORCE pela função do alicerce; GRANT ao runtime dentro de guarda de existência do papel. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.external_op_types (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        code varchar(64) NOT NULL,
        module varchar(40) NOT NULL,
        reversibility varchar(12) NOT NULL,
        compensation text NOT NULL DEFAULT '',
        procedure text NOT NULL DEFAULT '',
        owner varchar(120) NOT NULL DEFAULT '',
        entity varchar(64) NULL,
        operations text[] NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT external_op_types_reversibility_chk CHECK (reversibility IN ('REVERSIBLE', 'COMPENSABLE', 'IRREVERSIBLE')),
        CONSTRAINT external_op_types_code_uq UNIQUE (company_id, code),
        CONSTRAINT external_op_types_id_company_uq UNIQUE (company_id, id)
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.external_op_types'::regclass)");
      await q(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON governance.external_op_types TO nayara_runtime;
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.external_op_types');
  },
};
