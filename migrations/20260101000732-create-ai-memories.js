'use strict';

/**
 * M9-D009 — ai.memories: memória empresarial estruturada da NAY (fato operacional autorizado, nunca a conversa inteira).
 * Quatro tipos do livro, escopo COMPANY/USER/AGENT/SESSION, origem obrigatória (source_type + source_id), classificação, finalidade,
 * validade obrigatória (expires_at NOT NULL) e estados ACTIVE/INVALIDATED/EXPIRED/SUPERSEDED. Corrigir cria outra linha
 * (version + 1, supersedes_id); invalidar guarda quem, quando e por quê. Nada se apaga (gatilho da migration 733).
 * RLS ENABLE + FORCE por empresa; GRANT ao nayara_runtime só se o role existir.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('CREATE SCHEMA IF NOT EXISTS ai');
      await q(`CREATE TABLE IF NOT EXISTS ai.memories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        owner_user_id uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        memory_type varchar(30) NOT NULL,
        subject_type varchar(64) NULL,
        subject_id varchar(128) NULL,
        scope varchar(10) NOT NULL,
        agent_code varchar(64) NULL,
        value jsonb NOT NULL,
        source_type varchar(20) NOT NULL,
        source_id uuid NOT NULL,
        classification varchar(12) NOT NULL DEFAULT 'INTERNAL',
        purpose varchar(300) NULL,
        valid_from timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at timestamptz NOT NULL,
        status varchar(12) NOT NULL DEFAULT 'ACTIVE',
        version integer NOT NULL DEFAULT 1,
        supersedes_id uuid NULL REFERENCES ai.memories(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        invalidated_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        invalidated_at timestamptz NULL,
        invalidation_reason text NULL,
        idempotency_key varchar(200) NULL,
        created_by uuid NULL,
        updated_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT memories_type_chk CHECK (memory_type IN ('DECISION', 'COMPANY_PREFERENCE', 'APPROVED_PROCEDURE', 'RECOMMENDATION_OUTCOME')),
        CONSTRAINT memories_scope_chk CHECK (scope IN ('COMPANY', 'USER', 'AGENT', 'SESSION')),
        CONSTRAINT memories_status_chk CHECK (status IN ('ACTIVE', 'INVALIDATED', 'EXPIRED', 'SUPERSEDED')),
        CONSTRAINT memories_class_chk CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
        CONSTRAINT memories_source_type_chk CHECK (source_type IN ('RUN', 'RECOMMENDATION', 'KNOWLEDGE_ENTRY')),
        CONSTRAINT memories_value_chk CHECK (jsonb_typeof(value) = 'object'),
        CONSTRAINT memories_owner_chk CHECK (scope NOT IN ('USER', 'SESSION') OR owner_user_id IS NOT NULL),
        CONSTRAINT memories_agent_chk CHECK (scope <> 'AGENT' OR agent_code IS NOT NULL),
        CONSTRAINT memories_subject_chk CHECK (subject_id IS NULL OR subject_type IS NOT NULL),
        CONSTRAINT memories_validity_chk CHECK (expires_at > valid_from),
        CONSTRAINT memories_version_chk CHECK (version >= 1 AND (version = 1 OR supersedes_id IS NOT NULL)),
        CONSTRAINT memories_invalidation_chk CHECK (status <> 'INVALIDATED'
          OR (invalidated_by IS NOT NULL AND invalidated_at IS NOT NULL AND length(btrim(coalesce(invalidation_reason, ''))) > 0))
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS ai_memories_supersedes_uq ON ai.memories (supersedes_id) WHERE supersedes_id IS NOT NULL');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS ai_memories_idem_uq ON ai.memories (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
      await q('CREATE INDEX IF NOT EXISTS ai_memories_company_status_idx ON ai.memories (company_id, status, expires_at)');
      await q("CREATE INDEX IF NOT EXISTS ai_memories_subject_idx ON ai.memories (company_id, subject_type, subject_id) WHERE status = 'ACTIVE'");
      await q('ALTER TABLE ai.memories ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE ai.memories FORCE ROW LEVEL SECURITY');
      await q('DROP POLICY IF EXISTS tenant_isolation ON ai.memories');
      await q(`CREATE POLICY tenant_isolation ON ai.memories
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
               AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT USAGE ON SCHEMA ai TO nayara_runtime;
            GRANT SELECT, INSERT, UPDATE, DELETE ON ai.memories TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM ai.memories', { transaction });
      if (n > 0) throw new Error('ai.memories tem memórias gravadas (histórico que não se apaga); remova-as de propósito antes de reverter a migration.');
      await sequelize.query('DROP TABLE IF EXISTS ai.memories', { transaction });
    });
  },
};
