'use strict';

/**
 * M9-D008 — gatilho de ai.knowledge_entries: estados do conhecimento, edição só em DRAFT, homologador diferente do autor,
 * versão homologada imutável e revogada que não reativa.
 */
const { criarFuncaoConhecimento } = require('./_helpers/aiKnowledgeFunctions');

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await criarFuncaoConhecimento(q);
      await q('DROP TRIGGER IF EXISTS knowledge_entries_guard ON ai.knowledge_entries');
      await q('CREATE TRIGGER knowledge_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON ai.knowledge_entries FOR EACH ROW EXECUTE FUNCTION ai.knowledge_entries_guard()');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TRIGGER IF EXISTS knowledge_entries_guard ON ai.knowledge_entries');
      await q('DROP FUNCTION IF EXISTS ai.knowledge_entries_guard()');
    });
  },
};
