'use strict';

/**
 * Migration: achado real da auditoria técnica independente da Nayara (A05) — a conclusão de uma
 * tarefa de transferência de titularidade de água/luz (completeOwnershipTransfer) não exigia
 * nenhum comprovante. Adiciona `evidence_file_id` (opcional no schema, OBRIGATÓRIO na validação
 * do service) em `finance.ownership_transfer_tasks`. GRANT explícito (lição já documentada:
 * default privileges da migration de criação do schema não cobre coluna adicionada depois).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'ownership_transfer_tasks', schema: 'finance' },
      'evidence_file_id',
      { type: Sequelize.UUID, allowNull: true }
    );

    await queryInterface.sequelize.query(
      'GRANT SELECT, INSERT, UPDATE ON "finance"."ownership_transfer_tasks" TO nayara_runtime;'
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'ownership_transfer_tasks', schema: 'finance' }, 'evidence_file_id');
  },
};
