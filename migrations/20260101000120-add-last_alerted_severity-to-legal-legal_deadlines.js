'use strict';

/**
 * Migration: adiciona "legal"."legal_deadlines"."last_alerted_severity".
 *
 * FIX (reportado pela cliente 14/09/2026: "processos jurídicos, prazos e alertas efetivamente
 * utilizáveis"): severity (OVERDUE/DUE_SOON/NORMAL) já era calculada, mas só quando alguém
 * abria a tela de prazos — não existia nenhum alerta proativo. Esta coluna guarda a última
 * severidade que já gerou uma Notification, pra legalDeadlineAlertJob não reavisar a cada
 * rodada do mesmo prazo (só alerta de novo quando a severidade PIORA).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'legal_deadlines', schema: 'legal' },
      'last_alerted_severity',
      { type: Sequelize.STRING(16), allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'legal_deadlines', schema: 'legal' }, 'last_alerted_severity');
  },
};
