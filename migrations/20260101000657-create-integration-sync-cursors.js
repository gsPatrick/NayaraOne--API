'use strict';

/**
 * Marco 9, M9-D208 — integration.sync_cursors: cursores/checkpoints de sincronização retomáveis.
 * Um registro por (conexão, fluxo). O cursor só avança na mesma transação que grava os itens
 * (sync.runner); aqui ficam o ponteiro, o lease do worker e o contador de falhas.
 * RLS ENABLE + FORCE com a política tenant_isolation (padrão de correspondent.webhook_inbox).
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql, opts) => queryInterface.sequelize.query(sql, opts);

    await q(`
      CREATE TABLE "integration"."sync_cursors" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        connection_id uuid NOT NULL REFERENCES "integration"."connections"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        stream varchar(64) NOT NULL CHECK (stream ~ '^[a-z0-9][a-z0-9._-]*$'),
        cursor_value text,
        cursor_kind varchar(10) NOT NULL DEFAULT 'TOKEN' CHECK (cursor_kind IN ('TOKEN', 'TIMESTAMP', 'SEQUENCE')),
        high_watermark timestamptz,
        status varchar(10) NOT NULL DEFAULT 'IDLE' CHECK (status IN ('IDLE', 'RUNNING', 'FAILED', 'STALLED')),
        lease_owner varchar(80),
        lease_expires_at timestamptz,
        last_success_at timestamptz,
        last_attempt_at timestamptz,
        last_error_code varchar(64),
        consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
        items_synced_total bigint NOT NULL DEFAULT 0 CHECK (items_synced_total >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT sync_cursors_connection_stream_unique UNIQUE (connection_id, stream)
      );
    `);
    await q('CREATE INDEX sync_cursors_company_status_idx ON "integration"."sync_cursors" (company_id, status);');

    await q('ALTER TABLE "integration"."sync_cursors" ENABLE ROW LEVEL SECURITY;');
    await q(`CREATE POLICY tenant_isolation ON "integration"."sync_cursors"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);
    await q('ALTER TABLE "integration"."sync_cursors" FORCE ROW LEVEL SECURITY;');

    const [[{ exists }]] = await q("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
    if (exists) {
      await q('GRANT SELECT, INSERT, UPDATE ON "integration"."sync_cursors" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "integration"."sync_cursors";');
  },
};
