'use strict';

/**
 * M9-D024 — vigência das fontes do RAG. (1) O conhecimento homologado cujo prazo de validade passou vira EXPIRED (HOMOLOGATED ->
 * EXPIRED é a única transição nova do gatilho; EXPIRED, como SUPERSEDED e REVOKED, não muda mais). (2) O estado da fonte no
 * momento da recuperação (ai.ai_sources.status_at_retrieval) ganha SUBSTITUIDA (versão mais nova da mesma origem) e NAO_INICIADA
 * (início de vigência ainda no futuro), além de VIGENTE, REVOGADA e EXPIRADA.
 */
const { criarFuncaoConhecimento } = require('./_helpers/aiKnowledgeFunctions');

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE ai.knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_status_chk');
      await q("ALTER TABLE ai.knowledge_entries ADD CONSTRAINT knowledge_status_chk CHECK (status IN ('DRAFT','HOMOLOGATED','REVOKED','SUPERSEDED','EXPIRED'))");
      await criarFuncaoConhecimento(q);
      await q('ALTER TABLE ai.ai_sources DROP CONSTRAINT IF EXISTS ai_sources_status_chk');
      await q("ALTER TABLE ai.ai_sources ADD CONSTRAINT ai_sources_status_chk CHECK (status_at_retrieval IN ('VIGENTE','REVOGADA','EXPIRADA','SUBSTITUIDA','NAO_INICIADA'))");
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q("UPDATE ai.ai_sources SET status_at_retrieval = 'EXPIRADA' WHERE status_at_retrieval IN ('SUBSTITUIDA','NAO_INICIADA')");
      await q('ALTER TABLE ai.ai_sources DROP CONSTRAINT IF EXISTS ai_sources_status_chk');
      await q("ALTER TABLE ai.ai_sources ADD CONSTRAINT ai_sources_status_chk CHECK (status_at_retrieval IN ('VIGENTE','REVOGADA','EXPIRADA'))");
      await q('ALTER TABLE ai.knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_status_chk');
      await q("ALTER TABLE ai.knowledge_entries ADD CONSTRAINT knowledge_status_chk CHECK (status IN ('DRAFT','HOMOLOGATED','REVOKED','SUPERSEDED'))");
    });
  },
};
