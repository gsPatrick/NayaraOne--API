'use strict';

/**
 * Migration: cria "construction"."daily_materials" — materiais usados no dia de um RDO
 * (M6-09 do CHECKLIST_DE_ESCOPO Marco 6). DECISÃO DE ENGENHARIA: a integração completa com
 * Estoque (item_id vindo de um catálogo formal) é escopo de Marco 7 (M6-53, já registrado como
 * BLOQUEADO POR OUTRO MARCO no checklist) — por isso aqui o material é registrado por
 * descrição livre (`material_description`) + quantidade/unidade, sem FK obrigatória para
 * catálogo de estoque. Quando Marco 7 existir, adicionar `item_id` nullable apontando pro
 * catálogo, sem quebrar o que já foi lançado por descrição.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'daily_materials', schema: 'construction' },
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
        daily_report_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'daily_reports', schema: 'construction' }, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        material_description: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        quantity: {
          type: Sequelize.DECIMAL(14, 4),
          allowNull: false,
        },
        unit: {
          type: Sequelize.STRING(16),
          allowNull: false,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "construction"."daily_materials" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."daily_materials" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."daily_materials"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."daily_materials";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."daily_materials" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'daily_materials', schema: 'construction' });
  },
};
