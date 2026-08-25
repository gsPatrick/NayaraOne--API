'use strict';

/**
 * Migration: cria "construction"."budget_lines" — linha de orçamento/custo de uma obra
 * (previsto x realizado). DECISÃO DE ENGENHARIA: as fontes só citam `projects.budget_amount`
 * (um valor agregado único) — não há tabela de orçamento por linha/categoria documentada.
 * Criada para suportar "orçamento/custos" citado no escopo do Marco 6. `cost_center_id` é
 * opcional e referencia finance.cost_centers (já existente), permitindo religar a linha de
 * obra a um centro de custo financeiro sem duplicar conceito — mas nenhuma automação de
 * lançamento financeiro é criada aqui, é só uma referência informativa.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'budget_lines', schema: 'construction' },
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
        cost_center_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'cost_centers', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        category: {
          type: Sequelize.STRING(128),
          allowNull: false,
        },
        description: {
          type: Sequelize.STRING(255),
          allowNull: true,
        },
        planned_amount: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: false,
        },
        actual_amount: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: true,
        },
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

    await queryInterface.sequelize.query('ALTER TABLE "construction"."budget_lines" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."budget_lines" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."budget_lines"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."budget_lines";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."budget_lines" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'budget_lines', schema: 'construction' });
  },
};
