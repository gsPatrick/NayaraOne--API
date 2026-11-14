'use strict';

/** Migration: cria "finance"."financial_entries" — Ledger financeiro append-only — lançamento realizado (correção sempre por estorno/compensação, nunca UPDATE/DELETE destrutivo). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'financial_entries', schema: 'finance' },
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
        bank_account_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'bank_accounts', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        cost_center_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'cost_centers', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        result_center_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'result_centers', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        contract_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'contracts', schema: 'legal' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        entry_type: {
          type: Sequelize.STRING(16),
          allowNull: false,
        },
        nature: {
          type: Sequelize.STRING(32),
          allowNull: false,
        },
        amount: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: false,
        },
        due_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        settled_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'PENDING',
        },
        idempotency_key: {
          type: Sequelize.STRING(128),
          allowNull: true,
          unique: true,
        },
        reversal_of_entry_id: {
          type: Sequelize.UUID,
          allowNull: true,
        },
        lock_version: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "finance"."financial_entries" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."financial_entries" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."financial_entries"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."financial_entries";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."financial_entries" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'financial_entries', schema: 'finance' });
  },
};
