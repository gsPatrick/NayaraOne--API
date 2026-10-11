'use strict';

/**
 * GAP REAL CORRIGIDO (varredura completa Marco 4 contra o Caderno Técnico, 11/10/2026):
 * "finance.budgets_forecasts" é uma das 19 tabelas obrigatórias listadas na seção 5
 * ("Entidades/tabelas obrigatórias") — "Orçamento/projeção" — e nunca tinha sido criada. Não é
 * citada por nenhum dos 20 testes adversariais nem pela auditoria externa, mas é requisito
 * explícito do Caderno para "Marco 4 100% completo".
 *
 * Modelo mínimo: uma linha de orçamento por grupo/empresa/mês-competência/centro de
 * custo-ou-resultado/natureza, com o valor projetado. Comparação contra o realizado (via
 * finance.financial_entries) fica na camada de leitura (service), não duplicada aqui.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'budgets_forecasts', schema: 'finance' },
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
        competence_month: { type: Sequelize.STRING(7), allowNull: false, comment: 'YYYY-MM' },
        nature: { type: Sequelize.STRING(16), allowNull: false, comment: 'PAYABLE|RECEIVABLE' },
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
        description: { type: Sequelize.STRING(255), allowNull: true },
        forecasted_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addIndex(
      { tableName: 'budgets_forecasts', schema: 'finance' },
      ['company_id', 'competence_month'],
      { name: 'budgets_forecasts_company_month_idx' }
    );

    await queryInterface.sequelize.query('ALTER TABLE "finance"."budgets_forecasts" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."budgets_forecasts" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."budgets_forecasts"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."budgets_forecasts";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."budgets_forecasts" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'budgets_forecasts', schema: 'finance' });
  },
};
