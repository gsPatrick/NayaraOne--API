'use strict';

/**
 * Migration: adiciona "legal"."legal_deadlines"."first_overdue_alerted_at" e "escalated_at"
 * (M5-27 — escalonamento real de prazos jurídicos).
 *
 * Por que DUAS colunas: `last_alerted_severity` (já existente) diz QUAL foi o último alerta,
 * mas não QUANDO — e a regra de escalonamento é temporal ("continuou OVERDUE por mais de 24h
 * depois do primeiro alerta"). `first_overdue_alerted_at` marca o instante do primeiro alerta
 * de OVERDUE (nunca é sobrescrito depois), e `escalated_at` marca quando o escalonamento
 * efetivamente ocorreu — servindo também de guarda de idempotência: o job nunca escalona o
 * mesmo prazo duas vezes.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'legal_deadlines', schema: 'legal' },
      'first_overdue_alerted_at',
      { type: Sequelize.DATE, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'legal_deadlines', schema: 'legal' },
      'escalated_at',
      { type: Sequelize.DATE, allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'legal_deadlines', schema: 'legal' }, 'escalated_at');
    await queryInterface.removeColumn({ tableName: 'legal_deadlines', schema: 'legal' }, 'first_overdue_alerted_at');
  },
};
