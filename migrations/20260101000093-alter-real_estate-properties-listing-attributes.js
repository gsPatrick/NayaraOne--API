'use strict';

/**
 * Migration: adiciona a "real_estate"."properties" os atributos de anúncio que a ficha e o
 * formulário de imóvel do produto já usam e que não tinham coluna própria.
 *
 * - description        — texto livre do anúncio.
 * - bedrooms           — número de dormitórios.
 * - parking_spots      — número de vagas (total). O detalhamento coberta/descoberta continua
 *                        em attributes_json, junto das demais características do imóvel.
 * - attributes_json    — JSONB com as características booleanas/numéricas do imóvel
 *                        (mobiliado, piscina, portaria 24h, elevador, ano de construção,
 *                        vagas cobertas/descobertas etc.). É um bloco aberto por natureza —
 *                        cada tipo de imóvel expõe um conjunto diferente —, então segue o
 *                        mesmo padrão de coluna JSONB já usado no projeto para dados de forma
 *                        variável (persons.risk_flags_json, person_documents.extracted_data_json).
 *
 * ALTER incremental sobre a tabela existente, mesmo padrão da migration ...076 (alinhamento de
 * schema de properties). Todas as colunas são nullable — nenhum imóvel já cadastrado precisa
 * ser reescrito e o back-fill não é necessário.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = { tableName: 'properties', schema: 'real_estate' };

    await queryInterface.addColumn(table, 'description', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn(table, 'bedrooms', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn(table, 'parking_spots', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn(table, 'attributes_json', {
      type: Sequelize.JSONB,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    const table = { tableName: 'properties', schema: 'real_estate' };
    await queryInterface.removeColumn(table, 'attributes_json');
    await queryInterface.removeColumn(table, 'parking_spots');
    await queryInterface.removeColumn(table, 'bedrooms');
    await queryInterface.removeColumn(table, 'description');
  },
};
