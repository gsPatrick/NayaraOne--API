'use strict';

/**
 * Marco 9, M9-D235 — e-mail recebido pelo pipeline de malware e dado pessoal.
 *  - integration.email_inbound_messages: a mensagem recebida, SÓ com o texto já mascarado (o corpo original nunca é guardado), com a marca de dado pessoal, o vínculo (ou a falta dele) e
 *    o identificador do provedor (único por connection: a repetição é ignorada).
 *  - integration.email_inbound_attachments: um anexo por linha, ligado à quarentena (files.quarantine) e, quando limpo, ao arquivo promovido do módulo de arquivos.
 * As duas com RLS ENABLE + FORCE e GRANT ao runtime dentro de guarda de existência do role.
 */
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
      CREATE TABLE IF NOT EXISTS "integration"."email_inbound_messages" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        connection_id uuid NOT NULL REFERENCES "integration"."connections"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        provider_code varchar(48) NOT NULL,
        inbox_id uuid,
        external_message_id varchar(160) NOT NULL,
        from_address varchar(254),
        to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
        subject varchar(300) NOT NULL DEFAULT '',
        body_masked text,
        contains_pii boolean NOT NULL DEFAULT false,
        pii_types jsonb NOT NULL DEFAULT '[]'::jsonb,
        pan_redacted boolean NOT NULL DEFAULT false,
        link_status varchar(10) NOT NULL DEFAULT 'UNLINKED' CHECK (link_status IN ('LINKED', 'UNLINKED')),
        link_kind varchar(10) CHECK (link_kind IS NULL OR link_kind IN ('REPLY', 'REFERENCE', 'MANUAL')),
        linked_entity_type varchar(60),
        linked_entity_id varchar(64),
        linked_email_message_id uuid,
        linked_by uuid,
        linked_at timestamptz,
        received_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q('CREATE UNIQUE INDEX IF NOT EXISTS email_inbound_messages_provider_id_uidx ON "integration"."email_inbound_messages" (connection_id, external_message_id);');
    await q('CREATE INDEX IF NOT EXISTS email_inbound_messages_link_idx ON "integration"."email_inbound_messages" (company_id, link_status, received_at DESC);');
    await rls('email_inbound_messages');
    await q(`
      CREATE TABLE IF NOT EXISTS "integration"."email_inbound_attachments" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        message_id uuid NOT NULL REFERENCES "integration"."email_inbound_messages"(id) ON DELETE CASCADE ON UPDATE CASCADE,
        position integer NOT NULL,
        file_name varchar(255),
        declared_mime varchar(160),
        size_bytes bigint NOT NULL DEFAULT 0,
        sha256 varchar(64),
        quarantine_id uuid,
        status varchar(12) NOT NULL DEFAULT 'QUARANTINED' CHECK (status IN ('QUARANTINED', 'CLEAN', 'BLOCKED', 'REJECTED')),
        block_code varchar(80),
        file_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q('CREATE UNIQUE INDEX IF NOT EXISTS email_inbound_attachments_pos_uidx ON "integration"."email_inbound_attachments" (message_id, position);');
    await q("CREATE INDEX IF NOT EXISTS email_inbound_attachments_pending_idx ON \"integration\".\"email_inbound_attachments\" (company_id, status) WHERE status = 'QUARANTINED';");
    await rls('email_inbound_attachments');
    await q(`DO $g$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        GRANT USAGE ON SCHEMA "integration" TO nayara_runtime;
        GRANT SELECT, INSERT, UPDATE ON "integration"."email_inbound_messages" TO nayara_runtime;
        GRANT SELECT, INSERT, UPDATE ON "integration"."email_inbound_attachments" TO nayara_runtime;
      END IF;
    END $g$;`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "integration"."email_inbound_attachments";');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "integration"."email_inbound_messages";');
  },
};
