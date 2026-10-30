'use strict';

/**
 * Marco 9, M9-D230 3.5 — identificadores INTERNOS estáveis da conversa e do canal de atendimento. crm.conversations é a conversa da pessoa por canal (WhatsApp), com o horário da última mensagem recebida
 * do cliente (a janela de atendimento); crm.channels é a linha da empresa naquele canal; crm.conversation_links guarda o par externo (connection + id no fornecedor) de cada um, com `superseded_at`
 * quando a troca de fornecedor (M9-D221) o substitui. A conversa não muda de id na troca: só ganha um par novo, e o par antigo fica como histórico.
 * RLS ENABLE + FORCE por empresa nas três tabelas; o runtime lê, grava e atualiza (nada é apagado). Idempotente.
 */
const TABELAS = ['channels', 'conversations', 'conversation_links'];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`CREATE TABLE IF NOT EXISTS "crm"."channels" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      kind varchar(32) NOT NULL DEFAULT 'WHATSAPP',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT crm_channels_company_kind_uq UNIQUE (company_id, kind)
    );`);
    await q(`CREATE TABLE IF NOT EXISTS "crm"."conversations" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      person_id uuid NOT NULL REFERENCES "people"."persons"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      channel varchar(32) NOT NULL DEFAULT 'WHATSAPP',
      channel_id uuid REFERENCES "crm"."channels"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      last_inbound_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT crm_conversations_person_channel_uq UNIQUE (company_id, person_id, channel)
    );`);
    await q(`CREATE TABLE IF NOT EXISTS "crm"."conversation_links" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      kind varchar(16) NOT NULL CHECK (kind IN ('CONVERSATION', 'CHANNEL')),
      internal_id uuid NOT NULL,
      connection_id uuid NOT NULL REFERENCES "integration"."connections"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      external_id varchar(160) NOT NULL,
      superseded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );`);
    await q('CREATE UNIQUE INDEX IF NOT EXISTS crm_conversation_links_active_uq ON "crm"."conversation_links" (kind, internal_id, connection_id) WHERE superseded_at IS NULL;');
    await q('CREATE INDEX IF NOT EXISTS crm_conversation_links_external_idx ON "crm"."conversation_links" (company_id, kind, connection_id, external_id);');
    for (const t of TABELAS) {
      await q(`ALTER TABLE "crm"."${t}" ENABLE ROW LEVEL SECURITY;`);
      await q(`DROP POLICY IF EXISTS tenant_isolation ON "crm"."${t}";`);
      await q(`CREATE POLICY tenant_isolation ON "crm"."${t}"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
        WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);
      await q(`ALTER TABLE "crm"."${t}" FORCE ROW LEVEL SECURITY;`);
    }
    await q(`DO $g$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        GRANT USAGE ON SCHEMA "crm" TO nayara_runtime;
        GRANT SELECT, INSERT, UPDATE ON "crm"."channels", "crm"."conversations", "crm"."conversation_links" TO nayara_runtime;
      END IF;
    END $g$;`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TABLE IF EXISTS "crm"."conversation_links";');
    await q('DROP TABLE IF EXISTS "crm"."conversations";');
    await q('DROP TABLE IF EXISTS "crm"."channels";');
  },
};
