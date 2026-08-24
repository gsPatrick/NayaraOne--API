'use strict';

/**
 * Migration: cria "real_estate"."property_addresses" — Endereço interno de um imóvel.
 *
 * O Caderno Técnico confirma que "properties.address_id" referencia um endereço interno mas
 * NÃO detalha as colunas dessa tabela (lacuna real do documento-fonte). A estrutura abaixo
 * (CEP/logradouro/número/complemento/bairro/cidade/UF) é INFERÊNCIA de convenção de mercado
 * (endereço brasileiro padrão), não uma citação literal do Caderno — ver decisão registrada em
 * src/documentacao/features/Properties.md.
 *
 * Decisão de RLS: esta tabela NÃO tem group_id/company_id próprios (não é uma entidade
 * multiempresa por si só — é 1:1 com um "real_estate"."properties", que já tem RLS). Por isso
 * NÃO recebe policy própria; todo acesso a um endereço deve necessariamente passar por um JOIN
 * com "properties" (que filtra por company_id via RLS), o que já impede leitura cross-tenant na
 * prática. Aplicar RLS diretamente aqui exigiria duplicar group_id/company_id sem necessidade de
 * negócio (não há query direta a property_addresses fora do contexto de um property).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'property_addresses', schema: 'real_estate' },
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        zip_code: { type: Sequelize.STRING(9), allowNull: false },
        street: { type: Sequelize.STRING(200), allowNull: false },
        number: { type: Sequelize.STRING(20), allowNull: true },
        complement: { type: Sequelize.STRING(100), allowNull: true },
        neighborhood: { type: Sequelize.STRING(100), allowNull: false },
        city: { type: Sequelize.STRING(100), allowNull: false },
        state: { type: Sequelize.STRING(2), allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable({ tableName: 'property_addresses', schema: 'real_estate' });
  },
};
