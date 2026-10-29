'use strict';

/**
 * M9-D808 — governance.bulk_changes: o lote de alteração em massa (autor, motivo, filtro, patch, quantos registros mudaram). Estados DONE e FAILED
 * (FAILED = nada foi alterado). A Idempotency-Key do cabeçalho é única por empresa enquanto o lote não falhou: repetir a chamada devolve o lote original.
 * `request_hash` é o hash do corpo, para recusar a mesma chave com outro corpo. RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.bulk_changes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        entity_type varchar(20) NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'DONE',
        reason text NOT NULL,
        filter_json jsonb NOT NULL,
        patch_json jsonb NOT NULL,
        affected_count integer NOT NULL DEFAULT 0,
        idempotency_key varchar(128) NOT NULL,
        request_hash varchar(64) NOT NULL,
        error_message text NULL,
        created_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_bulk_entity_chk CHECK (entity_type IN ('PERSON', 'PROPERTY', 'SUPPLIER')),
        CONSTRAINT gov_bulk_status_chk CHECK (status IN ('DONE', 'FAILED')),
        CONSTRAINT gov_bulk_failed_chk CHECK (status <> 'FAILED' OR affected_count = 0)
      )`);
      await q("CREATE UNIQUE INDEX IF NOT EXISTS gov_bulk_key_uq ON governance.bulk_changes (company_id, idempotency_key) WHERE status <> 'FAILED'");
      await q('CREATE INDEX IF NOT EXISTS gov_bulk_list_idx ON governance.bulk_changes (company_id, created_at DESC)');
      await q("SELECT governance.apply_tenant_rls('governance.bulk_changes'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.bulk_changes');
  },
};
