'use strict';

/**
 * Migration: cria "real_estate"."property_documents" — Matrícula, IPTU, etc. de um imóvel.
 *
 * O Caderno Técnico confirma o nome/propósito ("Matrícula, IPTU etc.") mas não detalha colunas
 * — estrutura abaixo é INFERÊNCIA (document_type/label/value_number/value_amount/status),
 * documentada em src/documentacao/features/Properties.md. group_id/company_id próprios seguem
 * o mesmo padrão de RLS direto adotado em property_media (ver comentário lá).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'property_documents', schema: 'real_estate' },
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
          allowNull: false,
          references: { model: { tableName: 'properties', schema: 'real_estate' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        document_type: { type: Sequelize.STRING(50), allowNull: false, comment: 'IPTU|CONDO_FEE|REGISTRY|REGULARIZATION_CERTIFICATE' },
        label: { type: Sequelize.STRING(150), allowNull: true },
        value_number: { type: Sequelize.STRING(100), allowNull: true },
        value_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: true },
        status: { type: Sequelize.STRING(30), allowNull: true, comment: 'REGULARIZADO|EM_ANALISE|PENDENTE' },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addIndex(
      { tableName: 'property_documents', schema: 'real_estate' },
      ['property_id', 'document_type'],
      { name: 'property_documents_property_id_document_type_idx' }
    );

    await queryInterface.sequelize.query('ALTER TABLE "real_estate"."property_documents" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "real_estate"."property_documents" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "real_estate"."property_documents"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "real_estate"."property_documents";');
    await queryInterface.sequelize.query('ALTER TABLE "real_estate"."property_documents" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'property_documents', schema: 'real_estate' });
  },
};
