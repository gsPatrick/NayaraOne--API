'use strict';

/**
 * Marco 9, demanda M9-D671 (KPIs de Marketing: entregabilidade): campos que o KPI "Entregabilidade" precisa no read model rm_mkt_delivery da M9-D627.
 * Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da migration 9733. Idempotente. Faixa reservada: 9816 a 9823.
 *   bounced         mensagens do dia/canal devolvidas (BOUNCED), parte de `failed` (que soma FAILED, UNDELIVERED e BOUNCED)
 *   awaiting_since  instante da mensagem mais antiga do dia/canal ainda sem status final de entrega (regra de qualidade: sem status há mais de 24 h)
 *   by_campaign     { campanha: { sent, delivered } } do dia/canal; mensagem de automação (sem campanha) fica em "SEM_CAMPANHA"
 * Nascem NULOS e valem no próximo evento ou rebuild: nulo quer dizer "ainda não calculado" e o KPI não mostra valor.
 */
const COLUMNS = [
  'bounced integer CHECK (bounced IS NULL OR bounced >= 0)',
  'awaiting_since timestamptz',
  'by_campaign jsonb',
];

module.exports = {
  up: async (queryInterface) => {
    for (const column of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."rm_mkt_delivery" ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const column of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."rm_mkt_delivery" DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
