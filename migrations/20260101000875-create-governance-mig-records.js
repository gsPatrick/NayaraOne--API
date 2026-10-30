'use strict';

/**
 * M9-D900 — governance.mig_records: o estado de cada registro de origem (PENDING, MIGRATED, RECONCILED, QUARANTINED, PENDING_REVIEW, EXCLUDED; as transições e a Torre são da
 * M9-D901) com o conteúdo de origem (`source_payload`, `source_version`), o hash da linha e a marca de exclusão lógica na origem (`source_deleted`). Um registro por empresa, sistema,
 * entidade e chave. Também nasce governance.mig_event_keys: a chave de idempotência do aplicador (`<fonte>:<chave>:<posição>`) que impede reaplicar o mesmo evento. RLS + FORCE. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.mig_records (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        source_system varchar(40) NOT NULL,
        entity varchar(30) NOT NULL,
        source_key varchar(128) NOT NULL,
        state varchar(16) NOT NULL DEFAULT 'PENDING',
        reason text NULL,
        source_version integer NOT NULL DEFAULT 1,
        source_payload jsonb NULL,
        row_hash char(64) NULL,
        target_entity_id uuid NULL,
        batch_id uuid NULL REFERENCES governance.mig_batches(id) ON UPDATE CASCADE ON DELETE SET NULL,
        last_position text NULL,
        source_deleted boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT mig_records_state_chk CHECK (state IN ('PENDING', 'MIGRATED', 'RECONCILED', 'QUARANTINED', 'PENDING_REVIEW', 'EXCLUDED'))
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS mig_records_uq ON governance.mig_records (company_id, source_system, entity, source_key)');
      await q('CREATE INDEX IF NOT EXISTS mig_records_state_idx ON governance.mig_records (company_id, source_system, entity, state)');
      await q('CREATE INDEX IF NOT EXISTS mig_records_batch_idx ON governance.mig_records (batch_id)');
      await q("SELECT governance.apply_tenant_rls('governance.mig_records'::regclass)");
      await q(`CREATE TABLE IF NOT EXISTS governance.mig_event_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        idempotency_key varchar(260) NOT NULL,
        batch_id uuid NULL REFERENCES governance.mig_batches(id) ON UPDATE CASCADE ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS mig_event_keys_uq ON governance.mig_event_keys (company_id, idempotency_key)');
      await q("SELECT governance.apply_tenant_rls('governance.mig_event_keys'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.mig_event_keys');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.mig_records');
  },
};
