'use strict';

/** Migration: cria "finance"."bank_transactions" — Transação bruta importada do extrato bancário (OFX/API), insumo da conciliação. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'bank_transactions', schema: 'finance' },
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
          allowNull: false,
          references: { model: { tableName: 'bank_accounts', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        external_transaction_id: {
          type: Sequelize.STRING(128),
          allowNull: true,
          unique: true,
        },
        amount: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: false,
        },
        transaction_date: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        description: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "finance"."bank_transactions" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."bank_transactions" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."bank_transactions"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."bank_transactions";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."bank_transactions" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'bank_transactions', schema: 'finance' });
  },
};
