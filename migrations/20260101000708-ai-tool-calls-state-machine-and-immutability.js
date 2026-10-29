'use strict';

/**
 * M9-D006 — gatilho de ai.tool_calls: máquina de estados, imutabilidade em estado final, chamada nunca apagada e finished_at
 * preenchido ao entrar em estado final.
 */
const { criarFuncaoToolCalls } = require('./_helpers/aiToolCallsFunctions');

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await criarFuncaoToolCalls(q);
      await q('DROP TRIGGER IF EXISTS tool_calls_guard ON ai.tool_calls');
      await q('CREATE TRIGGER tool_calls_guard BEFORE INSERT OR UPDATE OR DELETE ON ai.tool_calls FOR EACH ROW EXECUTE FUNCTION ai.tool_calls_guard()');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TRIGGER IF EXISTS tool_calls_guard ON ai.tool_calls');
      await q('DROP FUNCTION IF EXISTS ai.tool_calls_guard()');
    });
  },
};
