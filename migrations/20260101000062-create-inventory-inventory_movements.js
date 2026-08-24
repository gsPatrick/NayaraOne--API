'use strict';

/** Migration: cria "inventory"."inventory_movements" — Movimentação append-only de entrada/saída de um item de estoque. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'inventory_movements', schema: 'inventory' },
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
        inventory_item_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'inventory_items', schema: 'inventory' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        project_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'projects', schema: 'construction' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        movement_type: {
          type: Sequelize.STRING(16),
          allowNull: false,
        },
        quantity: {
          type: Sequelize.DECIMAL(9, 6),
          allowNull: false,
        },
        moved_at: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        moved_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."inventory_movements" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."inventory_movements" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "inventory"."inventory_movements"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "inventory"."inventory_movements";');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."inventory_movements" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'inventory_movements', schema: 'inventory' });
  },
};
