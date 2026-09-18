'use strict';

/**
 * Migration: cria "legal"."contract_templates" (M5-01) — modelo de contrato por tipo
 * (SALE|LEASE|SERVICE) que agrupa cláusulas da biblioteca.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'contract_templates', schema: 'legal' },
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
        name: { type: Sequelize.STRING(255), allowNull: false },
        contract_type: {
          type: Sequelize.STRING(32),
          allowNull: false,
          comment: 'SALE|LEASE|SERVICE',
        },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_templates" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_templates" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "legal"."contract_templates"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "legal"."contract_templates";');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."contract_templates" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'contract_templates', schema: 'legal' });
  },
};
