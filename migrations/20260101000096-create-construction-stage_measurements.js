'use strict';

/**
 * Migration: cria "construction"."stage_measurements" — histórico formal de medição de uma
 * etapa de obra (project_stages), com workflow de aprovação. DECISÃO DE ENGENHARIA: os
 * documentos fonte (Maturacao/02_BANCO_DE_DADOS_E_RLS.md) só citam "project_stages" com
 * planned_pct/measured_pct — não há tabela de medição com histórico/aprovação documentada.
 * Essa tabela nasce para suportar "medições" citadas no escopo do Marco 6
 * (04_MAPA_DE_MARCOS_E_CRITERIOS_DE_ACEITE.md), registrando cada medição como um evento
 * append-only (nunca se edita uma medição já aprovada, só se registra uma nova) — mesmo
 * princípio de imutabilidade já usado no ledger financeiro e no histórico de preço de imóvel.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'stage_measurements', schema: 'construction' },
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
        project_stage_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'project_stages', schema: 'construction' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        measured_pct: {
          type: Sequelize.DECIMAL(9, 6),
          allowNull: false,
        },
        measured_at: {
          type: Sequelize.DATEONLY,
          allowNull: false,
        },
        measured_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        notes: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'PENDING_APPROVAL',
        },
        approved_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        decided_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        rejection_reason: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "construction"."stage_measurements" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."stage_measurements" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."stage_measurements"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."stage_measurements";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."stage_measurements" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'stage_measurements', schema: 'construction' });
  },
};
