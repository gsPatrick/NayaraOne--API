'use strict';

/**
 * M9-D005 — gatilho de ai.ai_runs: máquina de estados, imutabilidade em estado final, run nunca apagado e finished_at
 * preenchido ao entrar em estado final (as NAYs determinísticas inserem COMPLETED direto, sem informar o fim).
 */
const { criarFuncoesRuns } = require('./_helpers/aiRunsFunctions');

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await criarFuncoesRuns(q);
      await q('DROP TRIGGER IF EXISTS ai_runs_guard ON ai.ai_runs');
      await q('CREATE TRIGGER ai_runs_guard BEFORE INSERT OR UPDATE OR DELETE ON ai.ai_runs FOR EACH ROW EXECUTE FUNCTION ai.ai_runs_guard()');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TRIGGER IF EXISTS ai_runs_guard ON ai.ai_runs');
      await q('DROP FUNCTION IF EXISTS ai.ai_runs_guard()');
    });
  },
};
