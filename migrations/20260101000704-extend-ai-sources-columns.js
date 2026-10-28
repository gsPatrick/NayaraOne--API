'use strict';

/**
 * M9-D005 — evolui ai.ai_sources (fontes recuperadas por um run): versão, classificação, vigência, relevância, uso na
 * resposta, estado da fonte na recuperação e hash do conteúdo. O trecho (excerpt) nunca passa de 2000 caracteres no banco
 * (o limite fino é o parâmetro ia.fonte.excerpt_max_caracteres, lido pelo serviço) e as fontes de um run finalizado não mudam.
 * Valores legados de source_type (DB_RECORD, DOCUMENT) são mapeados para os do livro.
 */
const { criarFuncoesRuns } = require('./_helpers/aiRunsFunctions');

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE ai.ai_sources NO FORCE ROW LEVEL SECURITY');
      await q(`ALTER TABLE ai.ai_sources
        ADD COLUMN IF NOT EXISTS source_version varchar(60) NULL,
        ADD COLUMN IF NOT EXISTS classification varchar(16) NOT NULL DEFAULT 'INTERNAL',
        ADD COLUMN IF NOT EXISTS effective_from timestamptz NULL,
        ADD COLUMN IF NOT EXISTS effective_until timestamptz NULL,
        ADD COLUMN IF NOT EXISTS retrieved_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS relevance_score numeric(6,5) NULL,
        ADD COLUMN IF NOT EXISTS used_in_answer boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS status_at_retrieval varchar(12) NOT NULL DEFAULT 'VIGENTE',
        ADD COLUMN IF NOT EXISTS content_hash char(64) NULL`);
      await q("UPDATE ai.ai_sources SET source_type = CASE source_type WHEN 'DB_RECORD' THEN 'READ_MODEL' WHEN 'DOCUMENT' THEN 'DOCUMENT_CHUNK' WHEN 'KNOWLEDGE_ENTRY' THEN 'KNOWLEDGE_ENTRY' ELSE 'TOOL_RESULT' END WHERE source_type NOT IN ('READ_MODEL','DOCUMENT_CHUNK','KNOWLEDGE_ENTRY','MEMORY','TOOL_RESULT')");
      await q('UPDATE ai.ai_sources SET excerpt = left(excerpt, 2000) WHERE char_length(excerpt) > 2000');
      const checks = [
        ['ai_sources_type_chk', "source_type IN ('READ_MODEL','DOCUMENT_CHUNK','KNOWLEDGE_ENTRY','MEMORY','TOOL_RESULT')"],
        ['ai_sources_classification_chk', "classification IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')"],
        ['ai_sources_status_chk', "status_at_retrieval IN ('VIGENTE','REVOGADA','EXPIRADA')"],
        ['ai_sources_excerpt_chk', 'excerpt IS NULL OR char_length(excerpt) <= 2000'],
        ['ai_sources_relevance_chk', 'relevance_score IS NULL OR (relevance_score >= 0 AND relevance_score <= 1)'],
        ['ai_sources_effective_chk', 'effective_until IS NULL OR effective_from IS NULL OR effective_until >= effective_from'],
        ['ai_sources_hash_chk', "content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'"],
      ];
      for (const [nome, regra] of checks) {
        await q(`ALTER TABLE ai.ai_sources DROP CONSTRAINT IF EXISTS ${nome}`);
        await q(`ALTER TABLE ai.ai_sources ADD CONSTRAINT ${nome} CHECK (${regra})`);
      }
      await q('CREATE INDEX IF NOT EXISTS ai_sources_run_idx ON ai.ai_sources (ai_run_id)');
      await criarFuncoesRuns(q);
      await q('DROP TRIGGER IF EXISTS ai_sources_guard ON ai.ai_sources');
      await q('CREATE TRIGGER ai_sources_guard BEFORE INSERT OR UPDATE OR DELETE ON ai.ai_sources FOR EACH ROW EXECUTE FUNCTION ai.ai_sources_guard()');
      await q('ALTER TABLE ai.ai_sources FORCE ROW LEVEL SECURITY');
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT SELECT, INSERT, UPDATE, DELETE ON ai.ai_sources TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TRIGGER IF EXISTS ai_sources_guard ON ai.ai_sources');
      await q('DROP FUNCTION IF EXISTS ai.ai_sources_guard()');
      await q('DROP INDEX IF EXISTS ai.ai_sources_run_idx');
      for (const nome of ['type', 'classification', 'status', 'excerpt', 'relevance', 'effective', 'hash']) {
        await q(`ALTER TABLE ai.ai_sources DROP CONSTRAINT IF EXISTS ai_sources_${nome}_chk`);
      }
      for (const c of ['source_version', 'classification', 'effective_from', 'effective_until', 'retrieved_at', 'relevance_score',
        'used_in_answer', 'status_at_retrieval', 'content_hash']) {
        await q(`ALTER TABLE ai.ai_sources DROP COLUMN IF EXISTS ${c}`);
      }
    });
  },
};
