'use strict';

/**
 * M9-D863 — o catálogo de modelos da conexão de IA ganha o campo opcional `cheaperAlternative` (modelo mais barato do mesmo provedor, usado pelo passo
 * SWITCH_AI_MODEL_CHEAPER da degradação por custo). Regrava o schema do config_json dos provedores de IA com o schema atual do código. Idempotente.
 */
const { AI_CONNECTION_CONFIG_SCHEMA } = require('../src/features/ai/providers/connectionConfig.schema');

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE "integration"."providers" SET config_schema = CAST(:schema AS jsonb), updated_at = now() WHERE domain = 'AI' AND config_schema <> '{}'::jsonb`,
      { replacements: { schema: JSON.stringify(AI_CONNECTION_CONFIG_SCHEMA) } }
    );
  },
  async down() {
    // O schema anterior é um subconjunto compatível: nada a desfazer.
  },
};
