'use strict';

/**
 * M9-D030 — ai.ai_runs.conversation_id: o agrupador de runs do chat (POST /v1/ai/agents/:code/chat). A conversa NÃO é memória
 * (M9-D009): não existe tabela de conversa nem texto guardado além do que o run já guarda (input_summary e output_summary
 * redigidos). A validade da conversa (ia.chat.conversa_validade_horas) conta do primeiro run do agrupador.
 * Sem tabela nova: a RLS FORCE de ai.ai_runs já cobre a coluna. Idempotente; o down remove índice e coluna.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE ai.ai_runs ADD COLUMN IF NOT EXISTS conversation_id uuid NULL');
      await q(`CREATE INDEX IF NOT EXISTS ai_runs_conversation_idx ON ai.ai_runs (company_id, conversation_id, started_at)
        WHERE conversation_id IS NOT NULL`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP INDEX IF EXISTS ai.ai_runs_conversation_idx');
      await q('ALTER TABLE ai.ai_runs DROP COLUMN IF EXISTS conversation_id');
    });
  },
};
