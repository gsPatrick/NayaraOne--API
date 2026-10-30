'use strict';

/**
 * Marco 9, M9-D234 — e-mail de saída pelo adapter.
 *  - integration.email_messages: a mensagem do domínio (destinatários, assunto, anexos como referência, finalidade, estado) ligada ao envio em integration.dispatches. O identificador
 *    da mensagem no provedor (external_message_id) é único por connection. O corpo da mensagem NÃO é guardado aqui (fica só o conteúdo minimizado do envio, que a retenção reduz ao hash).
 *  - integration.email_message_events: o histórico de eventos do provedor aplicados à mensagem (entregue, bounce soft ou hard, reclamação, falha).
 * As duas com RLS ENABLE + FORCE; o runtime lê, grava e atualiza a mensagem e só acrescenta eventos.
 */
const ESTADOS = ['QUEUED', 'SENT', 'DELIVERED', 'BOUNCED_SOFT', 'BOUNCED_HARD', 'COMPLAINED', 'FAILED'];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const rls = async (tabela) => {
      await q(`ALTER TABLE "integration"."${tabela}" ENABLE ROW LEVEL SECURITY;`);
      await q(`CREATE POLICY tenant_isolation ON "integration"."${tabela}"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
        WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);
      await q(`ALTER TABLE "integration"."${tabela}" FORCE ROW LEVEL SECURITY;`);
    };
    await q(`
      CREATE TABLE IF NOT EXISTS "integration"."email_messages" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        connection_id uuid NOT NULL REFERENCES "integration"."connections"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        provider_code varchar(48) NOT NULL,
        dispatch_id uuid REFERENCES "integration"."dispatches"(id) ON DELETE SET NULL ON UPDATE CASCADE,
        idempotency_key varchar(160) NOT NULL,
        purpose varchar(60),
        origin_type varchar(60),
        origin_id varchar(64),
        to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
        cc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
        bcc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
        reply_to varchar(254),
        subject varchar(300) NOT NULL,
        attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
        attachment_bytes bigint NOT NULL DEFAULT 0,
        external_message_id varchar(160),
        status varchar(16) NOT NULL DEFAULT 'QUEUED' CHECK (status IN (${ESTADOS.map((e) => `'${e}'`).join(', ')})),
        bounce_type varchar(8) CHECK (bounce_type IS NULL OR bounce_type IN ('hard', 'soft')),
        failure_reason varchar(300),
        sent_at timestamptz,
        delivered_at timestamptz,
        last_event_at timestamptz,
        requested_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q('CREATE UNIQUE INDEX IF NOT EXISTS email_messages_provider_id_uidx ON "integration"."email_messages" (connection_id, external_message_id) WHERE external_message_id IS NOT NULL;');
    await q('CREATE UNIQUE INDEX IF NOT EXISTS email_messages_idempotency_uidx ON "integration"."email_messages" (company_id, idempotency_key);');
    await q('CREATE INDEX IF NOT EXISTS email_messages_dispatch_idx ON "integration"."email_messages" (company_id, dispatch_id) WHERE dispatch_id IS NOT NULL;');
    await q('CREATE INDEX IF NOT EXISTS email_messages_status_idx ON "integration"."email_messages" (company_id, status, created_at DESC);');
    await rls('email_messages');

    await q(`
      CREATE TABLE IF NOT EXISTS "integration"."email_message_events" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        message_id uuid NOT NULL REFERENCES "integration"."email_messages"(id) ON DELETE CASCADE ON UPDATE CASCADE,
        inbox_id uuid,
        kind varchar(16) NOT NULL CHECK (kind IN ('DELIVERED', 'BOUNCED_SOFT', 'BOUNCED_HARD', 'COMPLAINED', 'FAILED')),
        previous_status varchar(16),
        bounce_type varchar(8),
        detail varchar(300),
        occurred_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q('CREATE INDEX IF NOT EXISTS email_message_events_message_idx ON "integration"."email_message_events" (message_id, created_at);');
    await q('CREATE UNIQUE INDEX IF NOT EXISTS email_message_events_inbox_uidx ON "integration"."email_message_events" (message_id, inbox_id) WHERE inbox_id IS NOT NULL;');
    await rls('email_message_events');

    await q(`DO $g$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        GRANT USAGE ON SCHEMA "integration" TO nayara_runtime;
        GRANT SELECT, INSERT, UPDATE ON "integration"."email_messages" TO nayara_runtime;
        GRANT SELECT, INSERT ON "integration"."email_message_events" TO nayara_runtime;
      END IF;
    END $g$;`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "integration"."email_message_events";');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "integration"."email_messages";');
  },
};
