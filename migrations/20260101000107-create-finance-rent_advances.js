'use strict';

/**
 * Migration: cria "finance"."rent_advances" — antecipação de aluguel (M07 Billing
 * Locação/Utilities). Produto SEPARADO de guaranteed_rent_contracts — tabela própria, nunca
 * misturada com o modelo de aluguel garantido (ver rentAdvance.service.js).
 *
 * Fluxo: eligibility -> proposal -> acceptance -> payment -> recovery, refletido em `status`.
 * Principal (`principal_amount`) e custo/juros (`cost_amount`) são contabilizados
 * SEPARADAMENTE no financeiro — dois FinancialEntry distintos, referenciados aqui por
 * `principal_entry_id`/`cost_entry_id` (nunca um único lançamento misturando os dois).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'rent_advances', schema: 'finance' },
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
        contract_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'contracts', schema: 'legal' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'ELIGIBILITY_PENDING',
          comment: 'ELIGIBILITY_PENDING|PROPOSED|ACCEPTED|PAID|RECOVERING|RECOVERED|REJECTED',
        },
        months_advanced: { type: Sequelize.INTEGER, allowNull: false },
        principal_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false },
        cost_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
        recovered_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
        proposed_at: { type: Sequelize.DATE, allowNull: true },
        accepted_at: { type: Sequelize.DATE, allowNull: true },
        paid_at: { type: Sequelize.DATE, allowNull: true },
        principal_entry_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        cost_entry_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
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

    await queryInterface.sequelize.query('ALTER TABLE "finance"."rent_advances" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."rent_advances" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."rent_advances"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."rent_advances";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."rent_advances" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'rent_advances', schema: 'finance' });
  },
};
