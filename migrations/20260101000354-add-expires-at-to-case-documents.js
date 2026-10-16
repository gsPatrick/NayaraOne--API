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

    await queryInterface.sequelize.query(
      'GRANT SELECT, INSERT, UPDATE ON "correspondent"."case_documents" TO nayara_runtime;'
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'case_documents', schema: 'correspondent' }, 'expires_at');
  },
};
