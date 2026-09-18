'use strict';

/**
 * Migration: cria "finance"."chart_of_accounts" — Plano de Contas (M4-01).
 *
 * Até aqui o módulo financeiro só tinha centros de custo (finance.cost_centers) e centros de
 * resultado (finance.result_centers) — que são dimensões GERENCIAIS de rateio, não um plano de
 * contas contábil. Sem plano de contas não há classificação contábil dos lançamentos
 * (ativo/passivo/PL/receita/despesa) nem hierarquia sintética/analítica.
 *
 * Hierarquia via auto-relacionamento (parent_account_id) — mesmo padrão já usado em
 * people.persons (merged_into_id) e finance.financial_entries (reversal_of_entry_id).
 * Desativação é lógica (is_active=false): uma conta com lançamento vinculado nunca é apagada.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'chart_of_accounts', schema: 'finance' },
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
        code: {
          type: Sequelize.STRING(32),
          allowNull: false,
          comment: 'Código contábil hierárquico (ex.: "1.1.01")',
        },
        name: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        account_type: {
          type: Sequelize.STRING(32),
          allowNull: false,
          comment: 'ASSET|LIABILITY|EQUITY|REVENUE|EXPENSE',
        },
        parent_account_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'chart_of_accounts', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
          comment: 'Auto-referência: conta sintética pai',
        },
        is_active: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // Código de conta é único DENTRO da empresa (multiempresa: cada empresa tem o seu plano).
    await queryInterface.addConstraint(
      { tableName: 'chart_of_accounts', schema: 'finance' },
      { fields: ['company_id', 'code'], type: 'unique', name: 'chart_of_accounts_company_code_uk' }
    );
    await queryInterface.addIndex(
      { tableName: 'chart_of_accounts', schema: 'finance' },
      ['parent_account_id'],
      { name: 'chart_of_accounts_parent_idx' }
    );

    await queryInterface.sequelize.query('ALTER TABLE "finance"."chart_of_accounts" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."chart_of_accounts" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."chart_of_accounts"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."chart_of_accounts";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."chart_of_accounts" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'chart_of_accounts', schema: 'finance' });
  },
};
