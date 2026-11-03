'use strict';

/**
 * Marco 8 — tabelas nomeadas no caderno e que ainda não existiam:
 * correspondent.provider_accounts e correspondent.integration_errors.
 * provider_accounts guarda a referência do cofre (secret_ref), nunca o segredo.
 * integration_errors guarda código e mensagem de negócio, nunca o corpo do provider.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;

    await queryInterface.createTable(
      { tableName: 'provider_accounts', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        group_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        company_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        provider_code: { type: Sequelize.STRING(32), allowNull: false },
        label: { type: Sequelize.STRING(120), allowNull: false },
        secret_ref: { type: Sequelize.STRING(160), allowNull: false },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.createTable(
      { tableName: 'integration_errors', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        group_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        company_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        financing_case_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'financing_cases', schema: 'correspondent' }, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
        },
        provider_code: { type: Sequelize.STRING(32), allowNull: false },
        operation: { type: Sequelize.STRING(40), allowNull: false },
        error_code: { type: Sequelize.STRING(64), allowNull: false },
        message: { type: Sequelize.STRING(500), allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    for (const table of ['provider_accounts', 'integration_errors']) {
      await sequelize.query(`ALTER TABLE "correspondent"."${table}" ENABLE ROW LEVEL SECURITY;`);
      await sequelize.query(`ALTER TABLE "correspondent"."${table}" FORCE ROW LEVEL SECURITY;`);
      await sequelize.query(`
        CREATE POLICY tenant_isolation ON "correspondent"."${table}"
          USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
      `);
    }

    const [[{ exists: runtimeExists }]] = await sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "correspondent"."provider_accounts" TO nayara_runtime;');
      await sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "correspondent"."integration_errors" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    for (const table of ['integration_errors', 'provider_accounts']) {
      await sequelize.query(`DROP POLICY IF EXISTS tenant_isolation ON "correspondent"."${table}";`);
      await queryInterface.dropTable({ tableName: table, schema: 'correspondent' });
    }
  },
};
