'use strict';

/**
 * Migration: cria "finance"."period_closures" — fechamento mensal com bloqueio de período
 * (M4-19).
 *
 * Sem fechamento de período, qualquer usuário podia criar ou editar lançamento num mês já
 * conciliado/reportado, mudando números que o contador e o cliente já tinham dado por
 * fechados. A partir daqui, um mês CLOSED rejeita criação/edição de lançamento com vencimento
 * naquele mês; reabrir exige motivo e fica auditado (reopen_reason/reopened_by_user_id).
 *
 * Um registro por (empresa, mês). O status alterna OPEN/CLOSED — o histórico de quem fechou/
 * reabriu e por quê fica tanto nas colunas quanto na trilha de auditoria (core.audit_logs).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'period_closures', schema: 'finance' },
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
        reference_month: {
          type: Sequelize.STRING(7),
          allowNull: false,
          comment: 'Mês de competência no formato "YYYY-MM" (ex.: "2026-09")',
        },
        status: {
          type: Sequelize.STRING(16),
          allowNull: false,
          defaultValue: 'OPEN',
          comment: 'OPEN|CLOSED',
        },
        closed_at: { type: Sequelize.DATE, allowNull: true },
        closed_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        reopened_at: { type: Sequelize.DATE, allowNull: true },
        reopened_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        reopen_reason: { type: Sequelize.TEXT, allowNull: true },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addConstraint(
      { tableName: 'period_closures', schema: 'finance' },
      { fields: ['company_id', 'reference_month'], type: 'unique', name: 'period_closures_company_month_uk' }
    );

    await queryInterface.sequelize.query('ALTER TABLE "finance"."period_closures" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."period_closures" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."period_closures"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."period_closures";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."period_closures" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'period_closures', schema: 'finance' });
  },
};
