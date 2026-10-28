'use strict';

/**
 * M9-D415 — action_key nos destinos das automações do Marketing.
 *
 * Cada ação de uma run leva uma `action_key` (sha256 em hexadecimal, 64 caracteres). Os application services de destino (registrar
 * mensagem em crm.messages, criar tarefa em core.tasks) gravam a chave; o UNIQUE parcial (company_id, action_key) garante que dois
 * envios com a mesma chave resultem em um registro só, mesmo numa corrida entre duas conexões. Coluna nula = registro que não veio
 * de automação (todos os existentes). RLS, FORCE e GRANTs das duas tabelas não mudam (colunas novas herdam os privilégios).
 *
 * Idempotente (IF NOT EXISTS), numa transação. O down remove índices e colunas.
 */
const TABLES = [
  { schema: 'crm', table: 'messages', index: 'crm_messages_action_key_uq' },
  { schema: 'core', table: 'tasks', index: 'core_tasks_action_key_uq' },
];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      for (const { schema, table, index } of TABLES) {
        await sequelize.query(`ALTER TABLE "${schema}"."${table}" ADD COLUMN IF NOT EXISTS action_key varchar(64) NULL`, { transaction });
        await sequelize.query(
          `ALTER TABLE "${schema}"."${table}" DROP CONSTRAINT IF EXISTS ${table}_action_key_format_ck`,
          { transaction }
        );
        await sequelize.query(
          `ALTER TABLE "${schema}"."${table}" ADD CONSTRAINT ${table}_action_key_format_ck CHECK (action_key IS NULL OR action_key ~ '^[0-9a-f]{64}$')`,
          { transaction }
        );
        await sequelize.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS ${index} ON "${schema}"."${table}" (company_id, action_key) WHERE action_key IS NOT NULL`,
          { transaction }
        );
      }
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      for (const { schema, table, index } of TABLES) {
        await sequelize.query(`DROP INDEX IF EXISTS "${schema}"."${index}"`, { transaction });
        await sequelize.query(`ALTER TABLE "${schema}"."${table}" DROP CONSTRAINT IF EXISTS ${table}_action_key_format_ck`, { transaction });
        await sequelize.query(`ALTER TABLE "${schema}"."${table}" DROP COLUMN IF EXISTS action_key`, { transaction });
      }
    });
  },
};
