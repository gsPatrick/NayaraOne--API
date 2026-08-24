'use strict';

/**
 * Migration: cria "real_estate"."property_internal_occurrences".
 *
 * Citação literal do Caderno Técnico: "Criar property_internal_occurrences para informações
 * não publicáveis: aceita permuta, pega veículo, problema documental, não financia,
 * negociação específica, risco, observação de proprietário." e "Permissão de leitura/escrita
 * deve ser específica; conteúdo nunca vai automaticamente para site/portais/IA pública."
 *
 * Colunas (occurrence_type/description/visibility/created_by) são INFERÊNCIA a partir dessa
 * citação — documentado em src/documentacao/features/Properties.md. A regra "nunca exposta
 * publicamente" é aplicada em código (propertyInternalOccurrences.service.js nunca é chamado a
 * partir de nenhuma rota pública, e não é incluída em nenhum serializer de properties/offers),
 * não apenas documentada aqui.
 *
 * group_id/company_id próprios seguem o mesmo padrão de RLS direto de property_media/
 * property_documents — aqui é ainda mais importante, dado o caráter sensível do conteúdo.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'property_internal_occurrences', schema: 'real_estate' },
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
        occurrence_type: {
          type: Sequelize.STRING(50),
          allowNull: false,
          comment: 'TRADE_ACCEPTED|VEHICLE_TRADE|DOCUMENT_ISSUE|NO_FINANCING|SPECIFIC_NEGOTIATION|RISK|OWNER_NOTE',
        },
        description: { type: Sequelize.TEXT, allowNull: true },
        visibility: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'INTERNAL' },
        created_by: { type: Sequelize.UUID, allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addIndex(
      { tableName: 'property_internal_occurrences', schema: 'real_estate' },
      ['property_id'],
      { name: 'property_internal_occurrences_property_id_idx' }
    );

    await queryInterface.sequelize.query('ALTER TABLE "real_estate"."property_internal_occurrences" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "real_estate"."property_internal_occurrences" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "real_estate"."property_internal_occurrences"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "real_estate"."property_internal_occurrences";');
    await queryInterface.sequelize.query('ALTER TABLE "real_estate"."property_internal_occurrences" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'property_internal_occurrences', schema: 'real_estate' });
  },
};
