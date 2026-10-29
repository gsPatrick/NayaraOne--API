'use strict';

/**
 * Marco 9, demanda M9-D641 (KPIs de prazos da Locação): campos de cálculo e de qualidade que os KPIs precisam dos read models de Locação da M9-D617. Nenhuma tabela nova: RLS, FORCE e
 * GRANT continuam os da migration 9718. Idempotente. Faixa reservada: 9824 a 9831.
 *   rm_rental_guarantees          without_date             garantias sem data de vencimento (exceto os tipos sem vencimento do parâmetro), regra de qualidade: INCOMPLETE
 *   rm_rental_obligations         without_deadline         obrigações abertas cujo contrato não tem início de vigência (o prazo), regra de qualidade: DEGRADED
 *                                 oldest_overdue_days      dias de calendário de São Paulo da obrigação vencida mais antiga
 *   rm_rental_inspections_keys    inspections_overdue      vistorias pendentes com data prevista anterior ao dia-base
 *                                 keys_return_overdue      chaves entregues e não devolvidas cuja devolução prevista (fim do contrato) é anterior ao dia-base
 *                                 keys_without_return_date chaves entregues e não devolvidas sem devolução prevista, regra de qualidade: DEGRADED
 * Todos NULOS até o read model ser recalculado (evento, agenda ou rebuild): nulo quer dizer "ainda não calculado" e o KPI não mostra valor.
 */
const COUNT = (name) => `${name} integer CHECK (${name} IS NULL OR ${name} >= 0)`;
const COLUMNS = [
  ['rm_rental_guarantees', COUNT('without_date')],
  ['rm_rental_obligations', COUNT('without_deadline')],
  ['rm_rental_obligations', COUNT('oldest_overdue_days')],
  ['rm_rental_inspections_keys', COUNT('inspections_overdue')],
  ['rm_rental_inspections_keys', COUNT('keys_return_overdue')],
  ['rm_rental_inspections_keys', COUNT('keys_without_return_date')],
];

module.exports = {
  up: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
