'use strict';

/** Migration: cria "inventory"."inventory_items" — Item de estoque (material, insumo, ferramenta) mantido em depósito. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('CREATE SCHEMA IF NOT EXISTS "inventory";');

    await queryInterface.createTable(
      { tableName: 'inventory_items', schema: 'inventory' },
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
        sku: {
          type: Sequelize.STRING(64),
          allowNull: true,
        },
        name: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        unit_of_measure: {
          type: Sequelize.STRING(16),
          allowNull: true,
        },
        quantity_on_hand: {
          type: Sequelize.DECIMAL(9, 6),
          allowNull: false,
          defaultValue: 0,
        },
        minimum_quantity: {
          type: Sequelize.DECIMAL(9, 6),
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
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."inventory_items" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."inventory_items" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "inventory"."inventory_items"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "inventory"."inventory_items";');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."inventory_items" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'inventory_items', schema: 'inventory' });
  },
};
