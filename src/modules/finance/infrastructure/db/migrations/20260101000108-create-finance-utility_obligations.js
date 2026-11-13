'use strict';

/**
 * Migration: cria "finance"."utility_obligations" — obrigação recorrente de utilidade
 * (água/energia/gás/condomínio/IPTU/SPU/outro) vinculada a um contrato de locação, com
 * responsável (locador/locatário) definido (M07 Billing Locação/Utilities).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'utility_obligations', schema: 'finance' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
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
        contract_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'contracts', schema: 'legal' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        utility_type: {
          type: Sequelize.STRING(32),
          allowNull: false,
          comment: 'WATER|ELECTRICITY|GAS|CONDO|IPTU|SPU|OTHER',
        },
        responsible_party: {
          type: Sequelize.STRING(16),
          allowNull: false,
          comment: 'LANDLORD|TENANT',
        },
        provider: { type: Sequelize.STRING(120), allowNull: true },
        account_number: { type: Sequelize.STRING(60), allowNull: true },
        transfer_required: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        evidence_file_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'files', schema: 'people' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'ACTIVE',
          comment: 'ACTIVE|TRANSFER_PENDING|TRANSFERRED|CLOSED',
        },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "finance"."utility_obligations" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."utility_obligations" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."utility_obligations"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."utility_obligations";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."utility_obligations" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'utility_obligations', schema: 'finance' });
  },
};
