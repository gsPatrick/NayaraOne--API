'use strict';

/** Migration: cria "ai"."ai_runs" — Execução de um agente/tool da NAY — registro de auditoria de orquestração de IA. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('CREATE SCHEMA IF NOT EXISTS "ai";');

    await queryInterface.createTable(
      { tableName: 'ai_runs', schema: 'ai' },
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        group_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        company_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        agent_name: {
          type: Sequelize.STRING(64),
          allowNull: false,
        },
        input_summary: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        tool_calls_json: {
          type: Sequelize.JSONB,
          allowNull: true,
        },
        output_summary: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'COMPLETED',
        },
        cost_amount: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: true,
        },
        correlation_id: {
          type: Sequelize.UUID,
          allowNull: true,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "ai"."ai_runs" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "ai"."ai_runs" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "ai"."ai_runs"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "ai"."ai_runs";');
    await queryInterface.sequelize.query('ALTER TABLE "ai"."ai_runs" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'ai_runs', schema: 'ai' });
  },
};
