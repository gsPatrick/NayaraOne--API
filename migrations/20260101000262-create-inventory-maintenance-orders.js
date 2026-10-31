'use strict';

/**
 * Migration: Marco 7 fase 8 (Guia do Marcelo) — "maintenance_orders". Construída junto com
 * tool_loans (fase 6/7) porque devolução de ferramenta danificada abre manutenção
 * automaticamente (EST-007/EST-TS-06) — dependência direta, não antecipação de fase.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'maintenance_orders', schema: 'inventory' },
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
        source_tool_loan_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'tool_loans', schema: 'inventory' }, key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE',
        },
        description: { type: Sequelize.TEXT, allowNull: true },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'OPEN', comment: 'OPEN|CLOSED' },
        opened_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        closed_at: { type: Sequelize.DATE, allowNull: true },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."maintenance_orders" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."maintenance_orders" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "inventory"."maintenance_orders"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "inventory"."maintenance_orders";');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."maintenance_orders" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'maintenance_orders', schema: 'inventory' });
  },
};
