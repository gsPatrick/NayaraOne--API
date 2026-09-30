'use strict';

/**
 * Migration: cria "construction"."change_orders" (M6-06/M6-33 do checklist do Marco 6) —
 * única forma de alterar valor de um orçamento já `APPROVED` (baseline imutável, M6-17).
 * Campos conforme especificado na fonte (seção 3, M6-06): projectId, reasonCode, description,
 * budgetImpact (Decimal, pode ser negativo — reduz custo), scheduleImpactDays,
 * evidenceFileIds (array de UUID de "core"."files", sem FK de array — validado em serviço,
 * mesmo padrão usado alhures no projeto para listas de anexos), status
 * (DRAFT/PENDING_APPROVAL/APPROVED/REJECTED).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'change_orders', schema: 'construction' },
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
        reason_code: {
          type: Sequelize.STRING(64),
          allowNull: false,
        },
        description: {
          type: Sequelize.TEXT,
          allowNull: false,
        },
        budget_impact: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: false,
        },
        schedule_impact_days: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },
        evidence_file_ids: {
          type: Sequelize.ARRAY(Sequelize.UUID),
          allowNull: false,
          defaultValue: [],
        },
        status: {
          type: Sequelize.STRING(20),
          allowNull: false,
          defaultValue: 'DRAFT',
        },
        decided_by: { type: Sequelize.UUID, allowNull: true },
        decided_at: { type: Sequelize.DATE, allowNull: true },
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

    await queryInterface.sequelize.query('ALTER TABLE "construction"."change_orders" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."change_orders" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."change_orders"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."change_orders";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."change_orders" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'change_orders', schema: 'construction' });
  },
};
