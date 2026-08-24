'use strict';

/** Migration: cria "legal"."insurance_cases" — Sinistro/caso de seguro vinculado a um imóvel ou contrato. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'insurance_cases', schema: 'legal' },
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
        property_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'properties', schema: 'real_estate' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        contract_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'contracts', schema: 'legal' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        policy_number: {
          type: Sequelize.STRING(64),
          allowNull: true,
        },
        case_type: {
          type: Sequelize.STRING(32),
          allowNull: true,
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'OPEN',
        },
        claim_amount: {
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

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "legal"."insurance_cases" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."insurance_cases" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "legal"."insurance_cases"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "legal"."insurance_cases";');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."insurance_cases" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'insurance_cases', schema: 'legal' });
  },
};
