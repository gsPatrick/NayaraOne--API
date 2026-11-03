'use strict';

/**
 * Migration: Marco 7 fase 10 (Guia do Marcelo §8/§10) — "counts"/"count_items": inventário
 * físico. Contagem NUNCA altera saldo direto (EST-TS-09) — gera divergência; só um ajuste
 * aprovado separadamente (ADJUSTMENT via movements.service) toca stock_balances.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'counts', schema: 'inventory' },
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
        location_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'locations', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'OPEN', comment: 'OPEN|COMPLETED' },
        counted_at: { type: Sequelize.DATE, allowNull: true },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."counts" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."counts" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "inventory"."counts"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    await queryInterface.createTable(
      { tableName: 'count_items', schema: 'inventory' },
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
        count_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'counts', schema: 'inventory' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        inventory_item_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'inventory_items', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        expected_quantity: { type: Sequelize.DECIMAL(14, 6), allowNull: true, comment: 'Snapshot do saldo no momento da contagem — travado no fechamento, não no cadastro.' },
        counted_quantity: { type: Sequelize.DECIMAL(14, 6), allowNull: false },
        divergence: { type: Sequelize.DECIMAL(14, 6), allowNull: true, comment: 'counted_quantity - expected_quantity, calculado no fechamento.' },
        adjustment_movement_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'inventory_movements', schema: 'inventory' }, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.addConstraint({ tableName: 'count_items', schema: 'inventory' }, {
      fields: ['count_id', 'inventory_item_id'],
      type: 'unique',
      name: 'count_items_count_item_unique',
    });
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."count_items" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."count_items" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "inventory"."count_items"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "inventory"."count_items";');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."count_items" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'count_items', schema: 'inventory' });

    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "inventory"."counts";');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."counts" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'counts', schema: 'inventory' });
  },
};
