'use strict';

/**
 * BUG REAL CORRIGIDO (30/09/2026, achado numa nova rodada de verificação de integrações do
 * Marco 6): a fonte exige "Prestador/equipe vinculado a Pessoa/Fornecedor E DOCUMENTAÇÃO
 * CORRESPONDENTE" — `daily_workers` só tinha o vínculo com Pessoa (`person_id`), sem nenhum
 * lugar para a documentação (ex.: certificado de treinamento/EPI daquele dia). Adiciona
 * `document_file_ids` (array de UUID, referenciando `storage.files`, mesmo padrão já usado em
 * `Nonconformity`/`DailyReport`).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'daily_workers', schema: 'construction' },
      'document_file_ids',
      { type: Sequelize.ARRAY(Sequelize.UUID), allowNull: false, defaultValue: [] }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'daily_workers', schema: 'construction' }, 'document_file_ids');
  },
};
