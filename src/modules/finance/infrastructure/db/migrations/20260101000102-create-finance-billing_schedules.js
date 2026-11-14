'use strict';

/**
 * Migration: cria "finance"."billing_schedules" — cronograma de cobrança de locação (Marco 5,
 * módulo de aplicação "M07 Billing Locação/Utilities" do Caderno técnico).
 *
 * DECISÃO DE ENGENHARIA — schema físico: 02_BANCO_DE_DADOS_E_RLS.md confirma que "billing" NÃO
 * é um dos 11 schemas físicos oficiais (core, people, real_estate, crm, legal, finance,
 * construction, inventory, integration, ai, audit) — é um módulo de aplicação. Como billing de
 * locação é fundamentalmente financeiro (gera FinancialEntry), colocamos as tabelas no schema
 * físico "finance", junto de financial_entries/commissions/owner_repasses.
 *
 * Uma "competência" (period, ex.: "2026-09") é única por contrato — UNIQUE (contract_id,
 * period) impede gerar a cobrança duas vezes para o mesmo mês do mesmo contrato.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'billing_schedules', schema: 'finance' },
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
        period: {
          type: Sequelize.STRING(7),
          allowNull: false,
          comment: 'Competência no formato YYYY-MM.',
        },
        due_date: { type: Sequelize.DATEONLY, allowNull: false },
        total_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false },
        paid_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
        balance: { type: Sequelize.DECIMAL(18, 2), allowNull: false },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'OPEN',
          comment: 'OPEN|PARTIALLY_PAID|PAID',
        },
        generated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query(`
      ALTER TABLE "finance"."billing_schedules" ADD CONSTRAINT billing_schedules_contract_period_unique UNIQUE (contract_id, period);
    `);

    await queryInterface.sequelize.query('ALTER TABLE "finance"."billing_schedules" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."billing_schedules" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."billing_schedules"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."billing_schedules";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."billing_schedules" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'billing_schedules', schema: 'finance' });
  },
};
