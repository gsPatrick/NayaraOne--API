'use strict';

/** Migration: cria "construction"."project_stages" — Etapa/marco físico de uma obra, com medição associada (RDO). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'project_stages', schema: 'construction' },
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
        project_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'projects', schema: 'construction' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        name: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        sequence: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 1,
        },
        planned_pct: {
          type: Sequelize.DECIMAL(9, 6),
          allowNull: true,
        },
        measured_pct: {
          type: Sequelize.DECIMAL(9, 6),
          allowNull: true,
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'PENDING',
        },
        starts_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        ends_at: {
          type: Sequelize.DATE,
          allowNull: true,
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
    await queryInterface.sequelize.query('ALTER TABLE "construction"."project_stages" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."project_stages" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."project_stages"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."project_stages";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."project_stages" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'project_stages', schema: 'construction' });
  },
};
