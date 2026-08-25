'use strict';

/**
 * Migration: cria "construction"."daily_reports" — RDO (Relatório Diário de Obra).
 * DECISÃO DE ENGENHARIA: nenhuma tabela de RDO está documentada nas fontes (Maturacao/) nem
 * existia no schema antes desta migration — só o nome "RDO" aparece citado no escopo do
 * Marco 6 (04_MAPA_DE_MARCOS_E_CRITERIOS_DE_ACEITE.md) e a palavra "diário" na descrição do
 * agente NAY Obras (05_IA_NAY_E_SEGURANCA.md). Campos escolhidos pelo padrão usual de um RDO
 * de construção civil (data, clima, efetivo de mão de obra, ocorrências) — não há base
 * documental além disso.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'daily_reports', schema: 'construction' },
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
        report_date: {
          type: Sequelize.DATEONLY,
          allowNull: false,
        },
        weather: {
          type: Sequelize.STRING(32),
          allowNull: true,
        },
        workforce_count: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },
        occurrences: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        reported_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
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

    await queryInterface.sequelize.query(`
      ALTER TABLE "construction"."daily_reports" ADD CONSTRAINT daily_reports_project_date_unique UNIQUE (project_id, report_date);
    `);

    await queryInterface.sequelize.query('ALTER TABLE "construction"."daily_reports" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."daily_reports" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."daily_reports"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."daily_reports";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."daily_reports" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'daily_reports', schema: 'construction' });
  },
};
