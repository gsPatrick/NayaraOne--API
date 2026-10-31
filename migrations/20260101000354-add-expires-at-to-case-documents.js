'use strict';

/**
 * Migration: Marco 8 — "Expiração de documento gera novo requirement automaticamente" (Caderno,
 * bloco "Documentos/OCR": "Documento substituído preserva versão anterior; expiração gera
 * requirement."). Adiciona `expires_at` (opcional) a `correspondent.case_documents` — quando
 * preenchido, o job `caseDocumentExpiryJob` usa esse campo pra detectar documentos vencidos e
 * reabrir o requirement automaticamente. GRANT explícito (lição da Fase 2: default privileges
 * da migration 336 não cobre tabelas/colunas adicionadas depois pela credencial real de DDL).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'case_documents', schema: 'correspondent' },
      'expires_at',
      { type: Sequelize.DATE, allowNull: true }
    );

    // Guard de existência do role (mesmo padrão das demais migrations de grant deste schema):
    // em bancos recém-criados (CI descartável), nayara_runtime não existe — o grant é pulado,
    // o runtime do CI (nayara_ci_app) recebe os seus grants no próprio workflow.
    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await queryInterface.sequelize.query(
        'GRANT SELECT, INSERT, UPDATE ON "correspondent"."case_documents" TO nayara_runtime;'
      );
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'case_documents', schema: 'correspondent' }, 'expires_at');
  },
};
