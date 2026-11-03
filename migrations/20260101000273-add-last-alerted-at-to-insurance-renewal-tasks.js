'use strict';

/**
 * Migration: fecha o gap real achado na auditoria "loop até secar" (rodada 7, 2026-10-05) — o
 * contrato (Anexo I, Insurance Hub) pede "renovação alerta", mas `InsuranceRenewalTask` era só
 * uma linha criada na emissão da apólice, nunca lida por nada (sem job, sem endpoint, sem UI).
 * `last_alerted_at` é o marcador de idempotência do novo `insuranceRenewalAlertJob.js` — mesmo
 * padrão de `legal_deadlines.first_overdue_alerted_at`: alerta uma vez, nunca duplica
 * Notification pro mesmo prazo em execuções seguintes do job.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'insurance_renewal_tasks', schema: 'procurement' },
      'last_alerted_at',
      { type: Sequelize.DATE, allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn(
      { tableName: 'insurance_renewal_tasks', schema: 'procurement' },
      'last_alerted_at'
    );
  },
};
