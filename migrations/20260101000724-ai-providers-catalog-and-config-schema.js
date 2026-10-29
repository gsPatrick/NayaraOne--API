'use strict';

/**
 * Marco 9, M9-D011 — provedores de IA no registro único de integrações (sem tabela ai.providers, decisão C13).
 *
 * 1. Semeia os fornecedores reais de modelo (anthropic, openai) no catálogo `integration.providers` (idempotente, só atualiza
 *    nome, capabilities e versões; nunca status nem política).
 * 2. Grava em `config_schema` dos provedores de domínio AI o schema do `config_json` da conexão (region, data_retention,
 *    contract_ref, lab_only, allowsConfidential, allowsRestricted, baseUrl, models), só onde o schema ainda está vazio: o que o
 *    administrador de plataforma já definiu não é sobrescrito.
 * Nenhuma tabela nova: não há RLS nem GRANT a acrescentar (integration.providers é o catálogo global da D200).
 */
const { seedCatalog } = require('../src/features/integrations/providers/catalog.seed');
const { AI_REAL_PROVIDERS } = require('../src/features/integrations/providers/catalog.providers');
const { AI_CONNECTION_CONFIG_SCHEMA } = require('../src/features/ai/providers/connectionConfig.schema');

module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await seedCatalog(sequelize, transaction, AI_REAL_PROVIDERS);
      await sequelize.query(
        `UPDATE "integration"."providers" SET config_schema = CAST(:schema AS jsonb), updated_at = now()
          WHERE domain = 'AI' AND config_schema = '{}'::jsonb`,
        { transaction, replacements: { schema: JSON.stringify(AI_CONNECTION_CONFIG_SCHEMA) } }
      );
    });
  },

  // Seed de dados: o down não apaga nada (conexões podem já apontar para os códigos).
  down: async () => {},
};
