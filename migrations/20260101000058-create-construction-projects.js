'use strict';

/** Migration: cria "construction"."projects" — Obra/empreendimento de construção civil. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('CREATE SCHEMA IF NOT EXISTS "construction";');

    await queryInterface.createTable(
      { tableName: 'projects', schema: 'construction' },
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
        property_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'properties', schema: 'real_estate' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        name: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        responsible_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        budget_amount: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: true,
        },
        starts_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        ends_at_planned: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'PLANNED',
        },
        lock_version: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
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
    await queryInterface.sequelize.query('ALTER TABLE "construction"."projects" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."projects" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."projects"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."projects";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."projects" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'projects', schema: 'construction' });
  },
};
