'use strict';

/**
 * Adiciona `content` (BYTEA, nullable) a "people"."files".
 *
 * DECISÃO DE ENGENHARIA — achado real na homologação (22/09/2026): o comentário original do
 * model File já documentava "o binário em si vive em storage dedicado (S3-compatível), nunca
 * no banco relacional" — mas esse storage dedicado NUNCA foi implementado em lugar nenhum do
 * sistema (nenhuma rota de upload existia). Resultado prático: era impossível anexar foto/
 * vídeo a uma vistoria pela interface, travando toda a homologação do módulo de vistorias.
 *
 * Este campo é um STOPGAP deliberado e documentado: guarda o binário direto no Postgres
 * (aceitável para o volume de homologação — fotos/documentos de vistoria, não um volume de
 * produção em escala), até que uma integração real com storage de objetos (S3/R2/etc.) seja
 * contratada e implementada. Nullable porque `File` continua podendo representar apenas
 * metadado (ex.: linkado a algo cujo binário vive em outro lugar/já foi migrado depois).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'files', schema: 'people' },
      'content',
      { type: Sequelize.BLOB('long'), allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'files', schema: 'people' }, 'content');
  },
};
