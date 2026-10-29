'use strict';

/**
 * M9-D832 — governance.manual_operation_imports: o registro de que uma operação manual foi importada (deduplicação). `UNIQUE (company_id, manual_reference)` impede que o mesmo
 * número de formulário execute o comando de negócio duas vezes; a segunda importação lê esta linha e devolve o resultado anterior (`result`) sem executar nada. Guarda a
 * referência do comando criado (`command_ref`), o que o serviço normal efetivamente gravou (`effect`, usado na comparação e no estorno) e quem importou. RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.manual_operation_imports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        manual_operation_id uuid NOT NULL REFERENCES governance.manual_operations(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        manual_reference varchar(20) NOT NULL,
        intended_action varchar(40) NOT NULL,
        command_ref varchar(200) NOT NULL,
        effect jsonb NOT NULL DEFAULT '{}'::jsonb,
        result varchar(12) NOT NULL,
        imported_by uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        imported_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_manual_import_ref_uq UNIQUE (company_id, manual_reference),
        CONSTRAINT gov_manual_import_op_uq UNIQUE (manual_operation_id),
        CONSTRAINT gov_manual_import_result_chk CHECK (result IN ('MATCHED', 'DIVERGENT'))
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.manual_operation_imports'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.manual_operation_imports');
  },
};
