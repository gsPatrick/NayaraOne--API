'use strict';

/**
 * Marco 9, demanda M9-D672 (KPIs de Atendimento): campos de cálculo que os KPIs precisam dos read models de Marketing e Atendimento da M9-D627. Nenhuma tabela nova: RLS, FORCE e
 * GRANT continuam os da migration 9733. Idempotente. Faixa reservada: 9824 a 9831.
 *   rm_mkt_reviews           rating_1 a rating_5   quantidade de avaliações de cada nota (contagem por nota do sup.reviews)
 *   rm_support_satisfaction  positive              respostas com nota 4 ou 5 (% de notas 4 ou 5 do sup.satisfaction)
 *   rm_support_sla           resolved_<prioridade>, within_<prioridade>  resolvidos e resolvidos dentro do SLA de ALTA, MEDIA e BAIXA; without_priority  resolvidos de severidade sem prioridade
 * Todos NULOS até o read model ser recalculado (evento, agenda ou rebuild): nulo quer dizer "ainda não calculado" e o KPI não mostra valor.
 */
const COUNT = (name) => `${name} integer CHECK (${name} IS NULL OR ${name} >= 0)`;
const COLUMNS = [
  ...[1, 2, 3, 4, 5].map((n) => ['rm_mkt_reviews', COUNT(`rating_${n}`)]),
  ['rm_support_satisfaction', COUNT('positive')],
  ...['alta', 'media', 'baixa'].flatMap((p) => [['rm_support_sla', COUNT(`resolved_${p}`)], ['rm_support_sla', COUNT(`within_${p}`)]]),
  ['rm_support_sla', COUNT('without_priority')],
];

module.exports = {
  up: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const [table, column] of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."${table}" DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
