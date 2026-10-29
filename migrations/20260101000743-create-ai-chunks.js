'use strict';

/**
 * M9-D023 — ai.chunks: pedaços de documentos indexados para a NAY (RAG). Cada chunk carrega a identidade da fonte (source_id, source_type,
 * source_version), a empresa, a classificação, a vigência (effective_from/until), a permissão de leitura exigida da origem
 * (required_permission), o escopo de dono, o vetor (float8[] + norma, com o modelo que o gerou) e o estado ACTIVE/REVOKED/EXPIRED/SUPERSEDED.
 * Sem pgvector: a similaridade de cosseno é calculada em SQL sobre os candidatos já filtrados por empresa e permissão. O conteúdo é
 * imutável; só mudam o estado e os metadados que a reconciliação copia da origem. Nada se apaga (gatilho).
 * RLS ENABLE + FORCE por empresa; GRANT ao nayara_runtime só se o role existir.
 */
const FUNCAO = `CREATE OR REPLACE FUNCTION ai.chunks_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
  DECLARE mutaveis text[] := ARRAY['status', 'classification', 'required_permission', 'owner_scope', 'owner_user_id', 'effective_until', 'updated_at'];
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'AI_CHUNK_DELETE_FORBIDDEN: chunk não é apagado; revogue-o' USING ERRCODE = 'AI064';
    END IF;
    IF (to_jsonb(NEW) - mutaveis) IS DISTINCT FROM (to_jsonb(OLD) - mutaveis) THEN
      RAISE EXCEPTION 'AI_CHUNK_IMMUTABLE: o conteúdo do chunk não muda; reindexe criando outra versão' USING ERRCODE = 'AI063';
    END IF;
    IF OLD.status <> NEW.status AND (OLD.status <> 'ACTIVE' OR NEW.status NOT IN ('REVOKED', 'EXPIRED', 'SUPERSEDED')) THEN
      RAISE EXCEPTION 'AI_CHUNK_STATE: de % para % não é permitido', OLD.status, NEW.status USING ERRCODE = 'AI063';
    END IF;
    RETURN NEW;
  END
  $f$`;

const FUNCAO_TRUNCATE = `CREATE OR REPLACE FUNCTION ai.chunks_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN
    RAISE EXCEPTION 'AI_CHUNK_DELETE_FORBIDDEN: chunk não é apagado; revogue-o' USING ERRCODE = 'AI064';
  END
  $f$`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('CREATE SCHEMA IF NOT EXISTS ai');
      await q(`CREATE TABLE IF NOT EXISTS ai.chunks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ingestion_id uuid NOT NULL REFERENCES ai.ingestions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        source_id uuid NOT NULL,
        source_type varchar(20) NOT NULL,
        source_version integer NOT NULL,
        chunk_index integer NOT NULL,
        content_redacted text NOT NULL,
        content_hash char(64) NOT NULL,
        tokens_count integer NOT NULL,
        classification varchar(12) NOT NULL,
        effective_from timestamptz NOT NULL,
        effective_until timestamptz NULL,
        required_permission varchar(64) NOT NULL,
        owner_scope varchar(10) NOT NULL DEFAULT 'COMPANY',
        owner_user_id uuid NULL,
        embedding float8[] NOT NULL,
        embedding_norm float8 NOT NULL,
        embedding_model varchar(128) NOT NULL,
        status varchar(12) NOT NULL DEFAULT 'ACTIVE',
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chunks_source_type_chk CHECK (source_type IN ('FILE', 'URL', 'KNOWLEDGE_ENTRY')),
        CONSTRAINT chunks_class_chk CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
        CONSTRAINT chunks_status_chk CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED', 'SUPERSEDED')),
        CONSTRAINT chunks_scope_chk CHECK (owner_scope IN ('COMPANY', 'AREA', 'USER')),
        CONSTRAINT chunks_owner_chk CHECK (owner_scope <> 'USER' OR owner_user_id IS NOT NULL),
        CONSTRAINT chunks_version_chk CHECK (source_version >= 1 AND chunk_index >= 0 AND tokens_count >= 1),
        CONSTRAINT chunks_content_chk CHECK (length(btrim(content_redacted)) > 0),
        CONSTRAINT chunks_hash_chk CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT chunks_permission_chk CHECK (length(btrim(required_permission)) > 0),
        CONSTRAINT chunks_vector_chk CHECK (cardinality(embedding) >= 1 AND embedding_norm > 0),
        CONSTRAINT chunks_validity_chk CHECK (effective_until IS NULL OR effective_until > effective_from)
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS ai_chunks_position_uq ON ai.chunks (company_id, source_type, source_id, source_version, chunk_index)');
      await q("CREATE INDEX IF NOT EXISTS ai_chunks_active_idx ON ai.chunks (company_id, required_permission, classification) WHERE status = 'ACTIVE'");
      await q('CREATE INDEX IF NOT EXISTS ai_chunks_source_idx ON ai.chunks (company_id, source_type, source_id, status)');
      await q("CREATE INDEX IF NOT EXISTS ai_chunks_fts_idx ON ai.chunks USING gin (to_tsvector('portuguese', content_redacted)) WHERE status = 'ACTIVE'");
      await q('ALTER TABLE ai.chunks ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE ai.chunks FORCE ROW LEVEL SECURITY');
      await q('DROP POLICY IF EXISTS tenant_isolation ON ai.chunks');
      await q(`CREATE POLICY tenant_isolation ON ai.chunks
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
               AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
      await q(FUNCAO);
      await q(FUNCAO_TRUNCATE);
      await q('DROP TRIGGER IF EXISTS chunks_guard ON ai.chunks');
      await q('CREATE TRIGGER chunks_guard BEFORE UPDATE OR DELETE ON ai.chunks FOR EACH ROW EXECUTE FUNCTION ai.chunks_guard()');
      await q('DROP TRIGGER IF EXISTS chunks_no_truncate ON ai.chunks');
      await q('CREATE TRIGGER chunks_no_truncate BEFORE TRUNCATE ON ai.chunks FOR EACH STATEMENT EXECUTE FUNCTION ai.chunks_no_truncate()');
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT USAGE ON SCHEMA ai TO nayara_runtime;
            GRANT SELECT, INSERT, UPDATE, DELETE ON ai.chunks TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM ai.chunks', { transaction });
      if (n > 0) throw new Error('ai.chunks tem chunks gravados (histórico que não se apaga); remova-os de propósito antes de reverter a migration.');
      await sequelize.query('DROP TABLE IF EXISTS ai.chunks', { transaction });
      await sequelize.query('DROP FUNCTION IF EXISTS ai.chunks_guard()', { transaction });
      await sequelize.query('DROP FUNCTION IF EXISTS ai.chunks_no_truncate()', { transaction });
    });
  },
};
