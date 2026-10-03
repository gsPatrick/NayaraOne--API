'use strict';

/**
 * Migration: Marco 7 fase 9 (Guia do Marcelo §11) — "loss_cases": perda, quebra ou extravio
 * NÃO é uma baixa comum (EST-010) — fica registrada aqui com evidência/responsável/estimativa,
 * e só gera o movimento LOSS/DISPOSAL quando aprovada (alçada inventory:approve).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'loss_cases', schema: 'inventory' },
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
        inventory_item_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'inventory_items', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        asset_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'assets', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        location_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'locations', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        quantity: { type: Sequelize.DECIMAL(14, 6), allowNull: true, comment: 'Quantidade perdida — aplicável a item de estoque, não a asset.' },
        responsible_person_id: { type: Sequelize.UUID, allowNull: true },
        context: { type: Sequelize.TEXT, allowNull: false },
        evidence_file_ids: { type: Sequelize.ARRAY(Sequelize.UUID), allowNull: false, defaultValue: [] },
        estimated_cost: { type: Sequelize.DECIMAL(18, 2), allowNull: true },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'OPEN', comment: 'OPEN|APPROVED|REJECTED' },
        resulting_movement_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'inventory_movements', schema: 'inventory' }, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
        },
        decided_by_user_id: { type: Sequelize.UUID, allowNull: true },
        decided_at: { type: Sequelize.DATE, allowNull: true },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.sequelize.query(`
      ALTER TABLE "inventory"."loss_cases" ADD CONSTRAINT loss_cases_item_or_asset_check
        CHECK (inventory_item_id IS NOT NULL OR asset_id IS NOT NULL);
    `);
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."loss_cases" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."loss_cases" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "inventory"."loss_cases"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "inventory"."loss_cases";');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."loss_cases" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'loss_cases', schema: 'inventory' });
  },
};
