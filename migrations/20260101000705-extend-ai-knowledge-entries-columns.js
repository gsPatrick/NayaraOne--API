'use strict';

/**
 * M9-D008 — evolui ai.knowledge_entries (conhecimento homologado e versionado da empresa) sem renomear: versão por fact_key,
 * estado (DRAFT, HOMOLOGATED, REVOKED, SUPERSEDED), homologação, revogação com motivo, hash do conteúdo, responsável, origem,
 * título e corpo estruturado. Linhas antigas (se houver) viram a versão 1 em DRAFT: ninguém as homologou, então o RAG não as lê.
 * Unicidade: uma versão por (empresa, fact_key, version) e UMA só HOMOLOGATED por (empresa, fact_key), inclusive em concorrência.
 * A tabela tem RLS FORCE: o preenchimento das linhas antigas desliga o FORCE só dentro desta transação.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE ai.knowledge_entries NO FORCE ROW LEVEL SECURITY');
      await q(`ALTER TABLE ai.knowledge_entries
        ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS status varchar(12) NOT NULL DEFAULT 'DRAFT',
        ADD COLUMN IF NOT EXISTS homologated_by uuid NULL,
        ADD COLUMN IF NOT EXISTS homologated_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS revoked_by uuid NULL,
        ADD COLUMN IF NOT EXISTS revoked_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS revoke_reason text NULL,
        ADD COLUMN IF NOT EXISTS content_hash char(64) NULL,
        ADD COLUMN IF NOT EXISTS owner_user_id uuid NULL,
        ADD COLUMN IF NOT EXISTS source_id uuid NULL,
        ADD COLUMN IF NOT EXISTS title varchar(200) NULL,
        ADD COLUMN IF NOT EXISTS body_structured jsonb NULL`);
      await q("UPDATE ai.knowledge_entries SET title = fact_key WHERE title IS NULL");
      await q("UPDATE ai.knowledge_entries SET content_hash = encode(sha256(convert_to(fact_value_json::text, 'UTF8')), 'hex') WHERE content_hash IS NULL");
      // Duas linhas antigas com o mesmo fact_key viram versões 1, 2, ... na ordem de criação.
      await q(`UPDATE ai.knowledge_entries k SET version = r.n
                 FROM (SELECT id, row_number() OVER (PARTITION BY company_id, fact_key ORDER BY created_at, id) AS n FROM ai.knowledge_entries) r
                WHERE k.id = r.id`);
      await q('ALTER TABLE ai.knowledge_entries ALTER COLUMN title SET NOT NULL');
      await q('ALTER TABLE ai.knowledge_entries ALTER COLUMN content_hash SET NOT NULL');

      const checks = [
        ['knowledge_status_chk', "status IN ('DRAFT','HOMOLOGATED','REVOKED','SUPERSEDED')"],
        ['knowledge_classification_chk', "classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')"],
        ['knowledge_version_chk', 'version >= 1'],
        ['knowledge_hash_chk', "content_hash ~ '^[0-9a-f]{64}$'"],
        ['knowledge_title_chk', 'length(btrim(title)) > 0'],
        ['knowledge_validity_chk', 'valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from'],
        ['knowledge_homologation_chk', "status = 'DRAFT' OR (homologated_by IS NOT NULL AND homologated_at IS NOT NULL)"],
        ['knowledge_revocation_chk', "status <> 'REVOKED' OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL AND length(btrim(revoke_reason)) > 0)"],
        ['knowledge_body_chk', "body_structured IS NULL OR jsonb_typeof(body_structured) IN ('object','array')"],
      ];
      for (const [nome, regra] of checks) {
        await q(`ALTER TABLE ai.knowledge_entries DROP CONSTRAINT IF EXISTS ${nome}`);
        await q(`ALTER TABLE ai.knowledge_entries ADD CONSTRAINT ${nome} CHECK (${regra})`);
      }
      await q('CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_fact_version_uq ON ai.knowledge_entries (company_id, fact_key, version)');
      await q("CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_one_homologated_uq ON ai.knowledge_entries (company_id, fact_key) WHERE status = 'HOMOLOGATED'");
      await q('CREATE INDEX IF NOT EXISTS ai_knowledge_company_status_idx ON ai.knowledge_entries (company_id, status, classification)');
      await q('ALTER TABLE ai.knowledge_entries FORCE ROW LEVEL SECURITY');
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT USAGE ON SCHEMA ai TO nayara_runtime;
            GRANT SELECT, INSERT, UPDATE, DELETE ON ai.knowledge_entries TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP INDEX IF EXISTS ai.ai_knowledge_fact_version_uq');
      await q('DROP INDEX IF EXISTS ai.ai_knowledge_one_homologated_uq');
      await q('DROP INDEX IF EXISTS ai.ai_knowledge_company_status_idx');
      for (const nome of ['status', 'classification', 'version', 'hash', 'title', 'validity', 'homologation', 'revocation', 'body']) {
        await q(`ALTER TABLE ai.knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_${nome}_chk`);
      }
      for (const c of ['version', 'status', 'homologated_by', 'homologated_at', 'revoked_by', 'revoked_at', 'revoke_reason', 'content_hash',
        'owner_user_id', 'source_id', 'title', 'body_structured']) {
        await q(`ALTER TABLE ai.knowledge_entries DROP COLUMN IF EXISTS ${c}`);
      }
    });
  },
};
