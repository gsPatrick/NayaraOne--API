'use strict';

/**
 * Migration: cria "real_estate"."property_media" — Fotos/vídeos de um imóvel.
 *
 * O Caderno Técnico confirma o nome/propósito da entidade ("Fotos/vídeos") mas não detalha
 * colunas — estrutura abaixo é INFERÊNCIA (storage_key/mime/size/position/classification/
 * quality_status seguem convenção usual de um catálogo de mídia com moderação), documentada em
 * src/documentacao/features/Properties.md. REG-IMO-001 (vídeo obrigatório para publicação)
 * depende de media_type='VIDEO' existir para o property_id — é o único campo desta tabela
 * exigido literalmente pelo motor de regras.
 *
 * Recebe group_id/company_id próprios (inferência, seguindo o padrão já estabelecido em todas
 * as outras tabelas multiempresa deste schema) para permitir RLS direto por tenant_isolation,
 * em vez de depender de JOIN — consistente com o padrão do resto do projeto.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'property_media', schema: 'real_estate' },
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
        media_type: { type: Sequelize.STRING(20), allowNull: false, comment: 'PHOTO|VIDEO' },
        storage_key: { type: Sequelize.STRING(500), allowNull: false },
        original_name: { type: Sequelize.STRING(255), allowNull: true },
        mime_type: { type: Sequelize.STRING(100), allowNull: true },
        size_bytes: { type: Sequelize.INTEGER, allowNull: true },
        position: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        classification: { type: Sequelize.STRING(30), allowNull: true, comment: "ex.: 'PUBLIC'" },
        quality_status: { type: Sequelize.STRING(30), allowNull: false, defaultValue: 'PENDING', comment: 'PENDING|APPROVED|REJECTED' },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addIndex(
      { tableName: 'property_media', schema: 'real_estate' },
      ['property_id', 'media_type'],
      { name: 'property_media_property_id_media_type_idx' }
    );

    await queryInterface.sequelize.query('ALTER TABLE "real_estate"."property_media" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "real_estate"."property_media" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "real_estate"."property_media"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "real_estate"."property_media";');
    await queryInterface.sequelize.query('ALTER TABLE "real_estate"."property_media" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'property_media', schema: 'real_estate' });
  },
};
