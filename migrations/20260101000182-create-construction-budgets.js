'use strict';

/**
 * Migration: cria "construction"."budgets" — orçamento agregado da obra (M6-04 do checklist do
 * Marco 6).
 *
 * DECISÃO DE ENGENHARIA: até esta migração só existia "construction"."budget_lines" (linha
 * solta de orçamento, sem nenhum agregado nem status). Criamos aqui o agregado "Budget" (um por
 * obra — ver índice único abaixo) com máquina de estados DRAFT->APPROVED. As linhas
 * (`budget_lines`) passam a poder se vincular a um `budget_id` (ver migração seguinte) — a
 * aprovação do agregado (`approveBudget`) é o único ponto que congela `baseline_amount` e
 * bloqueia edição direta de valor das linhas vinculadas (M6-17/M6-22): depois de `APPROVED`,
 * qualquer mudança de valor só é possível via Change Order aprovado (M6-06/M6-33).
 * `rule_version_id` referencia "construction"."margin_rules" e é gravado no momento da
 * aprovação, preservando qual versão da margem mínima estava vigente (M6-23/M6-61).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'budgets', schema: 'construction' },
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
        project_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'projects', schema: 'construction' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        status: {
          type: Sequelize.STRING(20),
          allowNull: false,
          defaultValue: 'DRAFT',
        },
        total_amount: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: false,
          defaultValue: 0,
        },
        baseline_amount: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: true,
        },
        rule_version_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'margin_rules', schema: 'construction' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        approved_at: { type: Sequelize.DATE, allowNull: true },
        approved_by: { type: Sequelize.UUID, allowNull: true },
        lock_version: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // Um orçamento agregado por obra (decisão de engenharia) — revisões pós-aprovação
    // acontecem via Change Order, nunca criando um segundo agregado "budget" para a mesma obra.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX budgets_unique_per_project
        ON "construction"."budgets" (project_id)
        WHERE deleted_at IS NULL;
    `);

    await queryInterface.sequelize.query('ALTER TABLE "construction"."budgets" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."budgets" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."budgets"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."budgets";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."budgets" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'budgets', schema: 'construction' });
  },
};
