'use strict';

/**
 * BUG REAL CORRIGIDO (30/09/2026, achado numa nova rodada de verificação de integrações do
 * Marco 6 — releitura do contrato): a fonte é explícita — "Diário registra obra/data/turno,
 * equipe, serviços, fotos, materiais, ocorrências e bloqueios". O RDO (`daily_reports`) nunca
 * teve NENHUM campo para evidência fotográfica — não é uma divergência de nome, é um campo
 * inteiro ausente. Adiciona `evidence_file_ids` (array de UUID, referenciando `storage.files`,
 * mesmo padrão de array de arquivo já usado em `Nonconformity.beforeEvidenceFileIds`).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'daily_reports', schema: 'construction' },
      'evidence_file_ids',
      { type: Sequelize.ARRAY(Sequelize.UUID), allowNull: false, defaultValue: [] }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'daily_reports', schema: 'construction' }, 'evidence_file_ids');
  },
};
