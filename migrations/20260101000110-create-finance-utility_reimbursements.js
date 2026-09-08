'use strict';

/**
 * Migration: cria "finance"."utility_reimbursements" — reembolso a receber gerado quando a
 * imobiliária paga uma conta de utilidade que era responsabilidade da OUTRA parte
 * (M07 Billing Locação/Utilities). `financial_entry_id` referencia o FinancialEntry real
 * (RECEIVABLE) criado por utilities.service.js — nunca um lançamento contábil duplicado fora
 * do ledger genérico.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'utility_reimbursements', schema: 'finance' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
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
        utility_obligation_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'utility_obligations', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        paid_by_party: { type: Sequelize.STRING(16), allowNull: false, comment: 'LANDLORD|TENANT|AGENCY' },
        owed_by_party: { type: Sequelize.STRING(16), allowNull: false, comment: 'LANDLORD|TENANT' },
        amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false },
        financial_entry_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'PENDING',
          comment: 'PENDING|SETTLED',
        },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "finance"."utility_reimbursements" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."utility_reimbursements" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."utility_reimbursements"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."utility_reimbursements";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."utility_reimbursements" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'utility_reimbursements', schema: 'finance' });
  },
};
