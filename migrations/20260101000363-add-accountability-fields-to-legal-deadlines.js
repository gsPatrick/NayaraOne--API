'use strict';

/**
 * Migration: auditoria técnica independente da Nayara (PDF "Auditoria_Marcos4_5_Patrick.pdf",
 * achados A07/A08/A09) — Prazos jurídicos (legal_deadlines) podiam nascer sem responsável, ser
 * concluídos sem evidência/nota, e ter o vencimento alterado sem justificativa. Adiciona os
 * campos necessários pra exigir isso no service (legalDeadlines.service.js).
 * GRANT explícito (lição já documentada no projeto: default privileges da migration de schema
 * não cobre colunas adicionadas depois pela credencial real de DDL).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'legal_deadlines', schema: 'legal' },
      'responsible_user_id',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'legal_deadlines', schema: 'legal' },
      'conclusion_evidence_file_id',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'legal_deadlines', schema: 'legal' },
      'conclusion_note',
      { type: Sequelize.TEXT, allowNull: true }
    );

    await queryInterface.sequelize.query(
      'GRANT SELECT, INSERT, UPDATE ON "legal"."legal_deadlines" TO nayara_runtime;'
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'legal_deadlines', schema: 'legal' }, 'responsible_user_id');
    await queryInterface.removeColumn({ tableName: 'legal_deadlines', schema: 'legal' }, 'conclusion_evidence_file_id');
    await queryInterface.removeColumn({ tableName: 'legal_deadlines', schema: 'legal' }, 'conclusion_note');
  },
};
