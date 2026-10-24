'use strict';

/**
 * Migration: Marco 7 (Estoque, Patrimônio e Compras) — fase 1 do Guia do Marcelo
 * (items+locations -> movements+balances).
 *
 * DECISÃO DE ENGENHARIA: já existe um scaffold mínimo de "inventory"."inventory_items" /
 * "inventory"."inventory_movements" / "inventory"."assets" desde o commit inicial, com saldo
 * embutido direto na linha do item (quantity_on_hand) e sem separação por local/depósito. O
 * Caderno (EST-001..EST-015) exige saldo por localização, derivado de movimentos (nunca
 * digitável), e 4 tipos de item (CONSUMABLE/TOOL/ASSET/SERVICE_ITEM). Em vez de recriar as
 * tabelas com nomes paralelos (ex.: "items"), esta migration ESTENDE aditivamente o scaffold
 * existente — mesmo padrão usado em Obras (projects.service.js) nesta mesma frente de trabalho.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    // ---- inventory.locations (nova) ----
    await queryInterface.createTable(
      { tableName: 'locations', schema: 'inventory' },
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
        name: { type: Sequelize.STRING(255), allowNull: false },
        location_type: {
          type: Sequelize.STRING(16),
          allowNull: false,
          defaultValue: 'WAREHOUSE',
          comment: 'WAREHOUSE|PROJECT_SITE',
        },
        project_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'projects', schema: 'construction' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."locations" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."locations" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "inventory"."locations"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    // ---- inventory.stock_balances (nova) — saldo por item x local, nunca digitável ----
    await queryInterface.createTable(
      { tableName: 'stock_balances', schema: 'inventory' },
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
        location_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'locations', schema: 'inventory' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        quantity_on_hand: { type: Sequelize.DECIMAL(14, 6), allowNull: false, defaultValue: 0 },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.addConstraint({ tableName: 'stock_balances', schema: 'inventory' }, {
      fields: ['inventory_item_id', 'location_id'],
      type: 'unique',
      name: 'stock_balances_item_location_unique',
    });
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."stock_balances" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."stock_balances" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "inventory"."stock_balances"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    // ---- inventory.inventory_items: + item_type (EST-001: 4 tipos de item) ----
    await queryInterface.addColumn(
      { tableName: 'inventory_items', schema: 'inventory' },
      'item_type',
      {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'CONSUMABLE',
        comment: 'CONSUMABLE|TOOL|ASSET|SERVICE_ITEM',
      }
    );

    // ---- inventory.inventory_movements: extensão para suportar 7 tipos + origem/destino + idempotência ----
    await queryInterface.addColumn(
      { tableName: 'inventory_movements', schema: 'inventory' },
      'source_location_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'locations', schema: 'inventory' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'inventory_movements', schema: 'inventory' },
      'destination_location_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'locations', schema: 'inventory' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'inventory_movements', schema: 'inventory' },
      'source_type',
      { type: Sequelize.STRING(32), allowNull: true, comment: 'RECEIPT|REQUISITION|TOOL_LOAN|ADJUSTMENT|COUNT|LOSS_CASE|MANUAL' }
    );
    await queryInterface.addColumn(
      { tableName: 'inventory_movements', schema: 'inventory' },
      'source_id',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'inventory_movements', schema: 'inventory' },
      'idempotency_key',
      { type: Sequelize.STRING(255), allowNull: true }
    );
    await queryInterface.addConstraint({ tableName: 'inventory_movements', schema: 'inventory' }, {
      fields: ['company_id', 'idempotency_key'],
      type: 'unique',
      name: 'inventory_movements_company_idempotency_unique',
    });

    // movement_type ganha os 4 tipos restantes (RETURN/ADJUSTMENT/LOSS/DISPOSAL) — já é STRING(16), sem ALTER necessário.
  },

  down: async (queryInterface) => {
    await queryInterface.removeConstraint({ tableName: 'inventory_movements', schema: 'inventory' }, 'inventory_movements_company_idempotency_unique');
    await queryInterface.removeColumn({ tableName: 'inventory_movements', schema: 'inventory' }, 'idempotency_key');
    await queryInterface.removeColumn({ tableName: 'inventory_movements', schema: 'inventory' }, 'source_id');
    await queryInterface.removeColumn({ tableName: 'inventory_movements', schema: 'inventory' }, 'source_type');
    await queryInterface.removeColumn({ tableName: 'inventory_movements', schema: 'inventory' }, 'destination_location_id');
    await queryInterface.removeColumn({ tableName: 'inventory_movements', schema: 'inventory' }, 'source_location_id');

    await queryInterface.removeColumn({ tableName: 'inventory_items', schema: 'inventory' }, 'item_type');

    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "inventory"."stock_balances";');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."stock_balances" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'stock_balances', schema: 'inventory' });

    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "inventory"."locations";');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."locations" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'locations', schema: 'inventory' });
  },
};
