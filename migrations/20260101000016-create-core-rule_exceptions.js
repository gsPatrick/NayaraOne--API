'use strict';

/** Migration: cria "core"."rule_exceptions" — Exceção temporária a uma regra, com alvo, justificativa e prazo definidos. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'rule_exceptions', schema: 'core' },
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
        rule_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'rules', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        target_entity_type: {
          type: Sequelize.STRING(64),
          allowNull: false,
        },
        target_entity_id: {
          type: Sequelize.UUID,
          allowNull: false,
        },
        justification: {
          type: Sequelize.TEXT,
          allowNull: false,
        },
        starts_at: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        ends_at: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        approved_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "core"."rule_exceptions" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "core"."rule_exceptions" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "core"."rule_exceptions"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "core"."rule_exceptions";');
    await queryInterface.sequelize.query('ALTER TABLE "core"."rule_exceptions" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'rule_exceptions', schema: 'core' });
  },
};
