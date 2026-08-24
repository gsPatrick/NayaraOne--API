'use strict';

/** Migration: cria "crm"."visits" — Visita agendada/realizada a um imóvel por um cliente. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'visits', schema: 'crm' },
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
          allowNull: false,
          references: { model: { tableName: 'properties', schema: 'real_estate' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        opportunity_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'opportunities', schema: 'crm' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        person_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        agent_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        scheduled_at: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'SCHEDULED',
        },
        feedback: {
          type: Sequelize.TEXT,
          allowNull: true,
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
    await queryInterface.sequelize.query('ALTER TABLE "crm"."visits" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "crm"."visits" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "crm"."visits"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "crm"."visits";');
    await queryInterface.sequelize.query('ALTER TABLE "crm"."visits" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'visits', schema: 'crm' });
  },
};
