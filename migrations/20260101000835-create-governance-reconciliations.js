'use strict';

/**
 * M9-D832 — governance.reconciliations: a conferência entre o que o papel dizia e o que o comando normal gravou. Uma linha por operação importada (`result` MATCHED ou
 * DIVERGENT, `diff` com campo, valor do papel e valor do comando). MATCHED nasce concluída (`reconciled_by`/`reconciled_at`); DIVERGENT espera a decisão do responsável do
 * setor (`decision` ACCEPT ou REVERSE com `decided_by`, `decided_at` e `decision_note` obrigatória), e só então ganha `reconciled_*` (ACCEPT) ou fica sem (REVERSE: a operação
 * vira REJECTED por estorno). RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.reconciliations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        manual_operation_id uuid NOT NULL REFERENCES governance.manual_operations(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        command_ref varchar(200) NOT NULL,
        result varchar(12) NOT NULL,
        diff jsonb NOT NULL DEFAULT '[]'::jsonb,
        reconciled_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        reconciled_at timestamptz NULL,
        decision varchar(8) NULL,
        decided_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        decided_at timestamptz NULL,
        decision_note text NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_reconciliation_op_uq UNIQUE (manual_operation_id),
        CONSTRAINT gov_reconciliation_result_chk CHECK (result IN ('MATCHED', 'DIVERGENT')),
        CONSTRAINT gov_reconciliation_decision_chk CHECK (decision IS NULL OR decision IN ('ACCEPT', 'REVERSE')),
        CONSTRAINT gov_reconciliation_decided_chk CHECK ((decision IS NULL) = (decided_at IS NULL) AND (decision IS NULL OR (decision_note IS NOT NULL AND decided_by IS NOT NULL)))
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_reconciliation_pending_idx ON governance.reconciliations (company_id, result, decision)');
      await q("SELECT governance.apply_tenant_rls('governance.reconciliations'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.reconciliations');
  },
};
