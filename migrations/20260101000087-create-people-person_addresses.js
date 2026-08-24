'use strict';

/**
 * Migration: cria "people"."person_addresses" — Endereços versionados de uma pessoa.
 *
 * O Caderno Técnico confirma apenas o NOME da tabela ("Endereços versionados."), sem detalhar
 * colunas — lacuna real do documento-fonte. A estrutura abaixo (CEP/logradouro/número/
 * complemento/bairro/cidade/UF + is_current/valid_from/valid_until) é INFERÊNCIA, seguindo o
 * mesmo padrão de endereço brasileiro já adotado em "real_estate"."property_addresses"
 * (migration 000075), acrescida de is_current/valid_from/valid_until para suportar o conceito
 * de "versionado" citado no rótulo da tabela (endereço atual vs. histórico).
 *
 * group_id/company_id próprios seguem o padrão de RLS direto (policy única "tenant_isolation")
 * já usado em todas as demais tabelas "people".*.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'person_addresses', schema: 'people' },
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
        person_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        zip_code: { type: Sequelize.STRING(9), allowNull: true },
        street: { type: Sequelize.STRING(200), allowNull: true },
        number: { type: Sequelize.STRING(20), allowNull: true },
        complement: { type: Sequelize.STRING(100), allowNull: true },
        neighborhood: { type: Sequelize.STRING(100), allowNull: true },
        city: { type: Sequelize.STRING(100), allowNull: true },
        state: { type: Sequelize.STRING(2), allowNull: true },
        is_current: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        valid_from: { type: Sequelize.DATEONLY, allowNull: true },
        valid_until: { type: Sequelize.DATEONLY, allowNull: true },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addIndex(
      { tableName: 'person_addresses', schema: 'people' },
      ['person_id', 'is_current'],
      { name: 'person_addresses_person_id_is_current_idx' }
    );

    await queryInterface.sequelize.query('ALTER TABLE "people"."person_addresses" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "people"."person_addresses" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "people"."person_addresses"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "people"."person_addresses";');
    await queryInterface.sequelize.query('ALTER TABLE "people"."person_addresses" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'person_addresses', schema: 'people' });
  },
};
