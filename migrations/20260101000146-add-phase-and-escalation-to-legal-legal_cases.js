'use strict';

/**
 * Migration: adiciona "legal"."legal_cases"."phase" (M5-26) e
 * "legal"."legal_cases"."escalation_user_id" (M5-27).
 *
 * `phase` é uma LISTA ABERTA (STRING, não ENUM) — os valores conhecidos hoje são
 * INITIAL_PETITION, DISCOVERY, TRIAL, APPEAL, CLOSED, mas rito processual varia por tipo de
 * ação e a cliente pode precisar de fases próprias; validar com ENUM no banco exigiria uma
 * migration por fase nova. O service valida contra a lista conhecida quando o valor está nela
 * e documenta a lista (LEGAL_CASE_PHASES em legalCases.service.js).
 *
 * `escalation_user_id` é quem recebe o alerta quando um prazo jurídico continua vencido além
 * da janela de escalonamento sem o responsável agir (ver legalDeadlineAlertJob.js).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'legal_cases', schema: 'legal' },
      'phase',
      {
        type: Sequelize.STRING(32),
        allowNull: true,
        comment: 'Fase processual (lista aberta): INITIAL_PETITION|DISCOVERY|TRIAL|APPEAL|CLOSED',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'legal_cases', schema: 'legal' },
      'escalation_user_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'legal_cases', schema: 'legal' }, 'escalation_user_id');
    await queryInterface.removeColumn({ tableName: 'legal_cases', schema: 'legal' }, 'phase');
  },
};
