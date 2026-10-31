'use strict';

/**
 * Migration: Marco 8 Fase 2 (fechamento do pipeline de documento) — adiciona
 * `duplicate_of_document_id` e `suggested_note` a `correspondent.case_documents`.
 *
 * Caderno: "Upload → malware scan → hash → OCR/IA → sugestão → validação humana." O malware
 * scan e o hash (checksumSha256) já existem desde sempre no storage genérico de arquivo
 * (src/features/files/files.service.js) — reusado aqui, não duplicado. Esta migration cobre o
 * que faltava especificamente no Correspondente: sinalizar re-upload do MESMO conteúdo exato
 * pro mesmo requirement (nunca bloqueia, só sinaliza — mesmo espírito do dedupe de pessoas do
 * Marco 3), e guardar uma sugestão heurística determinística pro validador humano (substituto
 * honesto do "OCR/IA" — que é fronteira explícita com o Marco 9/NAY generativa, fora de escopo
 * aqui).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'case_documents', schema: 'correspondent' },
      'duplicate_of_document_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        comment: 'Preenchido quando o checksum do arquivo bate com uma versão anterior do MESMO requirement — nunca bloqueia, só sinaliza re-upload idêntico.',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'case_documents', schema: 'correspondent' },
      'suggested_note',
      {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Sugestão heurística determinística (não é IA/OCR) pro validador humano — ex: tipo de arquivo inesperado pro documentType.',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'case_documents', schema: 'correspondent' }, 'duplicate_of_document_id');
    await queryInterface.removeColumn({ tableName: 'case_documents', schema: 'correspondent' }, 'suggested_note');
  },
};
