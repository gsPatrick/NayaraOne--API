'use strict';

/** Migration: cria "finance"."tax_documents" — Documento fiscal emitido/recebido (NFS-e, DIMOB, comprovante de retenção). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'tax_documents', schema: 'finance' },
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
        contract_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'contracts', schema: 'legal' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        financial_entry_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'financial_entries', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        document_type: {
          type: Sequelize.STRING(32),
          allowNull: false,
        },
        document_number: {
          type: Sequelize.STRING(64),
          allowNull: true,
        },
        issued_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        amount: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: true,
        },
        file_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'files', schema: 'people' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
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
    await queryInterface.sequelize.query('ALTER TABLE "finance"."tax_documents" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."tax_documents" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."tax_documents"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."tax_documents";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."tax_documents" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'tax_documents', schema: 'finance' });
  },
};
