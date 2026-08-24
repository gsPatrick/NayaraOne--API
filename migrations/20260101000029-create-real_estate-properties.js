'use strict';

/** Migration: cria "real_estate"."properties" — Imóvel administrado/comercializado pela imobiliária. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('CREATE SCHEMA IF NOT EXISTS "real_estate";');

    await queryInterface.createTable(
      { tableName: 'properties', schema: 'real_estate' },
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
        title: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        property_type: {
          type: Sequelize.STRING(32),
          allowNull: false,
        },
        address_line: {
          type: Sequelize.STRING(255),
          allowNull: true,
        },
        city: {
          type: Sequelize.STRING(128),
          allowNull: true,
        },
        state: {
          type: Sequelize.STRING(2),
          allowNull: true,
        },
        zip_code: {
          type: Sequelize.STRING(16),
          allowNull: true,
        },
        area_total_m2: {
          type: Sequelize.DECIMAL(9, 6),
          allowNull: true,
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'AVAILABLE',
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
    await queryInterface.sequelize.query('ALTER TABLE "real_estate"."properties" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "real_estate"."properties" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "real_estate"."properties"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "real_estate"."properties";');
    await queryInterface.sequelize.query('ALTER TABLE "real_estate"."properties" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'properties', schema: 'real_estate' });
  },
};
