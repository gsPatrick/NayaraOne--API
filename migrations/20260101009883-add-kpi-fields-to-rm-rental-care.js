'use strict';

/**
 * Marco 9, demanda M9-D642 (KPIs de chamados, satisfação e repasses da Locação): campos de cálculo e de qualidade que os KPIs precisam dos read models de Locação da M9-D617.
 * Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da migration 9718. Idempotente. Faixa reservada: 9883 a 9890.
 *   rm_rental_tickets       opened_period             chamados abertos de 1º do mês de SP até a data-base
 *                           closed_period             chamados fechados (RESOLVED ou CLOSED) nesse mesmo período
 *                           resolution_hours_period   soma das horas de resolução dos fechados no período (a média é da fórmula)
 *                           without_open_date         fechados cuja abertura falta ou é posterior ao fechamento, regra de qualidade: DEGRADED
 *   rm_rental_satisfaction  tenant_responses, tenant_score_sum   respostas (e soma das notas) de quem é inquilino (TENANT) de contrato de locação
 *                           owner_responses, owner_score_sum     respostas (e soma das notas) de quem é proprietário (LANDLORD) de contrato de locação
 *   rm_rental_repasses      due_count                 repasses cuja data prevista cai de 1º do mês de SP até a data-base (devidos no período)
 *                           on_time_count             desses, os pagos até a data prevista
 *                           without_due_date          repasses pendentes ou pagos no período sem data prevista (mês de referência ausente ou inválido), regra de qualidade: DEGRADED
 * Todos NULOS até o read model ser recalculado (evento, agenda ou rebuild): nulo quer dizer "ainda não calculado" e o KPI não mostra valor.
 */
const COUNT = (name) => `${name} integer CHECK (${name} IS NULL OR ${name} >= 0)`;
const COLUMNS = [
  ['rm_rental_tickets', COUNT('opened_period')],
  ['rm_rental_tickets', COUNT('closed_period')],
  ['rm_rental_tickets', 'resolution_hours_period numeric(18,2) CHECK (resolution_hours_period IS NULL OR resolution_hours_period >= 0)'],
  ['rm_rental_tickets', COUNT('without_open_date')],
  ['rm_rental_satisfaction', COUNT('tenant_responses')],
  ['rm_rental_satisfaction', 'tenant_score_sum integer'],
  ['rm_rental_satisfaction', COUNT('owner_responses')],
  ['rm_rental_satisfaction', 'owner_score_sum integer'],
  ['rm_rental_repasses', COUNT('due_count')],
  ['rm_rental_repasses', COUNT('on_time_count')],
  ['rm_rental_repasses', COUNT('without_due_date')],
];

module.exports = {
  up: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
