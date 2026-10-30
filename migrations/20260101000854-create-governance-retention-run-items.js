'use strict';

/**
 * M9-D911 — governance.retention_run_items: o conjunto exato que a simulação decidiu descartar (uma linha por chave de registro, só a chave, nunca o dado). O apply
 * executa os PENDING em lotes (batch_no) e marca DONE; o que mudou desde a simulação (hold, exceção, política editada, registro que sumiu ou deixou de ser elegível)
 * vira SKIPPED_*. Um lote com erro é desfeito e seus itens continuam PENDING: o run retomado não repete lote concluído. RLS + FORCE (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.retention_run_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        run_id uuid NOT NULL REFERENCES governance.retention_runs(id) ON UPDATE CASCADE ON DELETE CASCADE,
        policy_code varchar(40) NOT NULL,
        policy_version integer NOT NULL,
        target_code varchar(40) NOT NULL,
        record_id varchar(64) NOT NULL,
        disposition varchar(10) NOT NULL,
        batch_no integer NOT NULL,
        state varchar(24) NOT NULL DEFAULT 'PENDING',
        reason text NULL,
        detail jsonb NULL,
        processed_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_ret_item_uq UNIQUE (run_id, target_code, record_id),
        CONSTRAINT gov_ret_item_disp_chk CHECK (disposition IN ('DELETE', 'ANONYMIZE', 'ARCHIVE')),
        CONSTRAINT gov_ret_item_state_chk CHECK (state IN ('PENDING', 'DONE', 'SKIPPED_HOLD', 'SKIPPED_EXCEPTION', 'SKIPPED_NOT_ELIGIBLE', 'SKIPPED_POLICY_CHANGED', 'SKIPPED_GONE'))
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_ret_item_batch_idx ON governance.retention_run_items (run_id, state, target_code, batch_no)');
      await q("CREATE INDEX IF NOT EXISTS gov_ret_item_done_idx ON governance.retention_run_items (company_id, target_code, record_id) WHERE state = 'DONE'");
      await q("SELECT governance.apply_tenant_rls('governance.retention_run_items'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.retention_run_items');
  },
};
