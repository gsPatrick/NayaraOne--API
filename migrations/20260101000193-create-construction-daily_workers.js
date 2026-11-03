'use strict';

/**
 * Migration: cria "construction"."daily_workers" — equipe do dia de um RDO (M6-08 do
 * CHECKLIST_DE_ESCOPO Marco 6), vinculada a `people.people` (Pessoa/Fornecedor), substituindo
 * o campo agregado `daily_reports.workforce_count` por registros individuais. Mantemos
 * `workforce_count` na tabela `daily_reports` por compatibilidade (DECISÃO DE ENGENHARIA:
 * não quebrar nada que já leia esse campo agregado — o valor pode ser recalculado a partir da
 * contagem de `daily_workers` por quem consumir o dado, sem exigirmos migração imediata de
 * todos os consumidores existentes).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'daily_workers', schema: 'construction' },
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
        person_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        role: {
          type: Sequelize.STRING(128),
          allowNull: true,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "construction"."daily_workers" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."daily_workers" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."daily_workers"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."daily_workers";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."daily_workers" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'daily_workers', schema: 'construction' });
  },
};
