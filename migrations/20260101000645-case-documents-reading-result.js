'use strict';

/**
 * Migration: guarda o RESULTADO da leitura automática do documento (sem o conteúdo sensível).
 * A validação humana passa a ser feita no servidor contra esse resultado: documento ilegível
 * nunca é validado e campo crítico ausente exige conferência informada por quem valida.
 * Os valores lidos continuam só na nota cifrada (suggested_note); aqui ficam apenas os NOMES
 * dos campos encontrados.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = { tableName: 'case_documents', schema: 'correspondent' };
    await queryInterface.addColumn(table, 'reading_status', {
      type: Sequelize.STRING(16),
      allowNull: true,
      comment: 'READ, ILLEGIBLE ou NOT_READ (leitor automático desligado ou indisponível). Nulo em documentos antigos.',
    });
    await queryInterface.addColumn(table, 'reading_found_fields', {
      type: Sequelize.JSONB,
      allowNull: true,
      comment: 'Nomes (não valores) dos campos que a leitura automática encontrou.',
    });
  },

  down: async (queryInterface) => {
    const table = { tableName: 'case_documents', schema: 'correspondent' };
    await queryInterface.removeColumn(table, 'reading_found_fields');
    await queryInterface.removeColumn(table, 'reading_status');
  },
};
