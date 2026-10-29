'use strict';

/**
 * M9-D006 + M9-D028 — retenção do conteúdo das chamadas de ferramenta. Quando ai.purge_ai_content (migration 20260101000715) marca
 * o run como expurgado (content_purged_at), o gatilho abaixo apaga, na mesma transação, args_sanitized e result_summary das
 * chamadas do run; o gatilho de ai.tool_calls aceita isso só com a marca de sessão ai.purge_mode ligada e só para APAGAR esses dois
 * campos. Funciona em qualquer ordem de migrations: a função é plpgsql e lê content_purged_at do run só quando o expurgo roda.
 */
const { criarFuncaoExpurgoDoRun } = require('./_helpers/aiToolCallsFunctions');

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await criarFuncaoExpurgoDoRun(q);
      await q('DROP TRIGGER IF EXISTS ai_runs_purge_tool_calls ON ai.ai_runs');
      await q(`CREATE TRIGGER ai_runs_purge_tool_calls AFTER UPDATE ON ai.ai_runs
        FOR EACH ROW EXECUTE FUNCTION ai.ai_runs_purge_tool_calls()`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TRIGGER IF EXISTS ai_runs_purge_tool_calls ON ai.ai_runs');
      await q('DROP FUNCTION IF EXISTS ai.ai_runs_purge_tool_calls()');
    });
  },
};
