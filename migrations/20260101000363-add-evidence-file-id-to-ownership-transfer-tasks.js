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

    // Guard de existência do role: em banco recém-criado (CI descartável) nayara_runtime não
    // existe — o grant é pulado; o runtime do CI (nayara_ci_app) recebe grants no workflow.
    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await queryInterface.sequelize.query(
        'GRANT SELECT, INSERT, UPDATE ON "finance"."ownership_transfer_tasks" TO nayara_runtime;'
      );
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'ownership_transfer_tasks', schema: 'finance' }, 'evidence_file_id');
  },
};
