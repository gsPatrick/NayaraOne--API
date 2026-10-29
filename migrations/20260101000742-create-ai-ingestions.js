'use strict';

/**
 * M9-D022 — ai.ingestions: uma linha por ingestão de arquivo, URL ou conhecimento homologado no índice da NAY (RAG). Guarda em que etapa
 * a ingestão parou ou foi rejeitada, o hash do conteúdo, a classificação e a versão da fonte. Estados: PENDING -> SCANNING -> PARSING ->
 * INDEXING -> INDEXED; qualquer etapa -> REJECTED (motivo em error_code) ou FAILED (erro técnico; reenviar é idempotente pelo hash).
 * INDEXED e REJECTED são finais: só uma reindexação nova (outra linha, outra versão) volta a indexar. Nada se apaga (gatilho).
 * RLS ENABLE + FORCE por empresa; GRANT ao nayara_runtime só se o role existir.
 */
const FUNCAO = `CREATE OR REPLACE FUNCTION ai.ingestions_guard() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'AI_INGESTION_DELETE_FORBIDDEN: ingestão não é apagada' USING ERRCODE = 'AI062';
    END IF;
    IF OLD.status IN ('INDEXED', 'REJECTED') AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'AI_INGESTION_FINAL: ingestão % não muda; reindexe criando outra versão', OLD.status USING ERRCODE = 'AI061';
    END IF;
    IF (NEW.company_id, NEW.source_kind, NEW.source_id, NEW.created_by) IS DISTINCT FROM (OLD.company_id, OLD.source_kind, OLD.source_id, OLD.created_by) THEN
      RAISE EXCEPTION 'AI_INGESTION_IMMUTABLE: a origem da ingestão não muda' USING ERRCODE = 'AI061';
    END IF;
    RETURN NEW;
  END
  $f$`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('CREATE SCHEMA IF NOT EXISTS ai');
      await q(`CREATE TABLE IF NOT EXISTS ai.ingestions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        source_kind varchar(20) NOT NULL,
        source_ref varchar(2048) NOT NULL,
        source_id uuid NOT NULL,
        status varchar(12) NOT NULL DEFAULT 'PENDING',
        step varchar(20) NOT NULL DEFAULT 'AUTHORIZE',
        error_code varchar(64) NULL,
        content_hash char(64) NULL,
        classification varchar(12) NULL,
        source_version integer NOT NULL DEFAULT 1,
        secrets_removed integer NOT NULL DEFAULT 0,
        active_content_discarded integer NOT NULL DEFAULT 0,
        chunks_count integer NOT NULL DEFAULT 0,
        created_by uuid NULL,
        started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT ingestions_kind_chk CHECK (source_kind IN ('FILE', 'URL', 'KNOWLEDGE_ENTRY')),
        CONSTRAINT ingestions_status_chk CHECK (status IN ('PENDING', 'SCANNING', 'PARSING', 'INDEXING', 'INDEXED', 'REJECTED', 'FAILED')),
        CONSTRAINT ingestions_class_chk CHECK (classification IS NULL OR classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
        CONSTRAINT ingestions_hash_chk CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT ingestions_version_chk CHECK (source_version >= 1),
        CONSTRAINT ingestions_counts_chk CHECK (secrets_removed >= 0 AND active_content_discarded >= 0 AND chunks_count >= 0),
        CONSTRAINT ingestions_rejected_chk CHECK (status NOT IN ('REJECTED', 'FAILED') OR error_code IS NOT NULL),
        CONSTRAINT ingestions_indexed_chk CHECK (status <> 'INDEXED' OR (content_hash IS NOT NULL AND classification IS NOT NULL AND finished_at IS NOT NULL))
      )`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS ai_ingestions_source_version_uq
        ON ai.ingestions (company_id, source_kind, source_id, source_version) WHERE status NOT IN ('REJECTED', 'FAILED')`);
      await q('CREATE INDEX IF NOT EXISTS ai_ingestions_company_status_idx ON ai.ingestions (company_id, status, created_at)');
      await q('CREATE INDEX IF NOT EXISTS ai_ingestions_source_idx ON ai.ingestions (company_id, source_kind, source_id, source_version DESC)');
      await q('ALTER TABLE ai.ingestions ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE ai.ingestions FORCE ROW LEVEL SECURITY');
      await q('DROP POLICY IF EXISTS tenant_isolation ON ai.ingestions');
      await q(`CREATE POLICY tenant_isolation ON ai.ingestions
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
               AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
      await q(FUNCAO);
      await q('DROP TRIGGER IF EXISTS ingestions_guard ON ai.ingestions');
      await q('CREATE TRIGGER ingestions_guard BEFORE UPDATE OR DELETE ON ai.ingestions FOR EACH ROW EXECUTE FUNCTION ai.ingestions_guard()');
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT USAGE ON SCHEMA ai TO nayara_runtime;
            GRANT SELECT, INSERT, UPDATE, DELETE ON ai.ingestions TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM ai.ingestions', { transaction });
      if (n > 0) throw new Error('ai.ingestions tem ingestões gravadas (histórico que não se apaga); remova-as de propósito antes de reverter a migration.');
      await sequelize.query('DROP TABLE IF EXISTS ai.ingestions', { transaction });
      await sequelize.query('DROP FUNCTION IF EXISTS ai.ingestions_guard()', { transaction });
    });
  },
};
