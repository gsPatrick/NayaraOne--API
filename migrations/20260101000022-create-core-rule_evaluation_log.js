'use strict';

/** Migration: cria "core"."rule_evaluation_log" — Log append-only de cada avaliação de regra em produção (observabilidade/auditoria). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'rule_evaluation_log', schema: 'core' },
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
        rule_version_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'rule_versions', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        evaluated_at: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        input_facts_json: {
          type: Sequelize.JSONB,
          allowNull: false,
        },
        decision: {
          type: Sequelize.STRING(32),
          allowNull: false,
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
    await queryInterface.sequelize.query('ALTER TABLE "core"."rule_evaluation_log" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "core"."rule_evaluation_log" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "core"."rule_evaluation_log"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "core"."rule_evaluation_log";');
    await queryInterface.sequelize.query('ALTER TABLE "core"."rule_evaluation_log" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'rule_evaluation_log', schema: 'core' });
  },
};
