'use strict';

/**
 * Migration: Marco 7 fase 5 (Guia do Marcelo) — "assets/QR". Estende o scaffold de
 * "inventory"."assets" (pré-existente) com os campos do TAB-0760 ("Banco de Dados Físico
 * BLINDADO") que faltavam — inventory_item_id (vínculo ao catálogo), current_location_id
 * (EST-014: localização) e warranty_until — e cria "inventory"."asset_movements" (EST-005/
 * item 9 do Caderno: toda transferência de asset gera um registro, nunca só um UPDATE mudo).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'assets', schema: 'inventory' },
      'inventory_item_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'inventory_items', schema: 'inventory' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'assets', schema: 'inventory' },
      'current_location_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'locations', schema: 'inventory' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'assets', schema: 'inventory' },
      'warranty_until',
      { type: Sequelize.DATE, allowNull: true }
    );

    await queryInterface.createTable(
      { tableName: 'asset_movements', schema: 'inventory' },
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
        asset_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'assets', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        source_location_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'locations', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        destination_location_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'locations', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        source_custodian_user_id: { type: Sequelize.UUID, allowNull: true },
        destination_custodian_user_id: { type: Sequelize.UUID, allowNull: true },
        idempotency_key: { type: Sequelize.STRING(255), allowNull: true },
        moved_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        moved_by_user_id: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.addConstraint({ tableName: 'asset_movements', schema: 'inventory' }, {
      fields: ['company_id', 'idempotency_key'],
      type: 'unique',
      name: 'asset_movements_company_idempotency_unique',
    });
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."asset_movements" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."asset_movements" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "inventory"."asset_movements"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "inventory"."asset_movements";');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."asset_movements" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'asset_movements', schema: 'inventory' });

    await queryInterface.removeColumn({ tableName: 'assets', schema: 'inventory' }, 'warranty_until');
    await queryInterface.removeColumn({ tableName: 'assets', schema: 'inventory' }, 'current_location_id');
    await queryInterface.removeColumn({ tableName: 'assets', schema: 'inventory' }, 'inventory_item_id');
  },
};
