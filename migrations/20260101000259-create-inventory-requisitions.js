'use strict';

/**
 * Migration: Marco 7 fase 4 (Guia do Marcelo) — "requisitions": requisição de material por
 * obra/etapa, com aprovação e baixa (OUT) que carrega project_id/stage_id (EST-004).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'requisitions', schema: 'inventory' },
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
        warehouse_location_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'locations', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        project_location_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'locations', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        project_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'projects', schema: 'construction' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        stage_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'project_stages', schema: 'construction' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'REQUESTED', comment: 'REQUESTED|APPROVED|REJECTED|ISSUED' },
        requested_by_user_id: { type: Sequelize.UUID, allowNull: true },
        approved_by_user_id: { type: Sequelize.UUID, allowNull: true },
        notes: { type: Sequelize.TEXT, allowNull: true },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."requisitions" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."requisitions" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "inventory"."requisitions"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    await queryInterface.createTable(
      { tableName: 'requisition_items', schema: 'inventory' },
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
        requisition_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'requisitions', schema: 'inventory' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        inventory_item_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'inventory_items', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        quantity: { type: Sequelize.DECIMAL(14, 6), allowNull: false },
        issued_quantity: { type: Sequelize.DECIMAL(14, 6), allowNull: false, defaultValue: 0 },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."requisition_items" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."requisition_items" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "inventory"."requisition_items"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "inventory"."requisition_items";');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."requisition_items" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'requisition_items', schema: 'inventory' });

    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "inventory"."requisitions";');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."requisitions" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'requisitions', schema: 'inventory' });
  },
};
