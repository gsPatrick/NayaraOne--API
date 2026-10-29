'use strict';

/**
 * Marco 9, demanda M9-D671 (KPIs de Marketing: frequência de contato): campos que o KPI "Frequência de contato" precisa no read model rm_mkt_frequency
 * da M9-D627. Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da migration 9733. Idempotente. Faixa reservada: 9816 a 9823.
 *   window_days      janela (dias) com que a linha foi calculada (parâmetro analytics.frequencia.janela_dias); janela diferente da vigente deixa o KPI sem valor
 *   window_messages  mensagens de automação ou campanha aceitas pelo provedor na janela que termina no dia da linha
 *   window_people    pessoas distintas que as receberam
 *   unidentified     mensagens da janela sem destinatário identificável (regra de qualidade: DEGRADED)
 *   by_channel       { canal: { messages, people } } da janela
 * Nascem NULOS e valem no próximo evento, na agenda ou no rebuild: nulo quer dizer "ainda não calculado" e o KPI não mostra valor.
 */
const COLUMNS = [
  'window_days integer CHECK (window_days IS NULL OR window_days >= 1)',
  'window_messages integer CHECK (window_messages IS NULL OR window_messages >= 0)',
  'window_people integer CHECK (window_people IS NULL OR window_people >= 0)',
  'unidentified integer CHECK (unidentified IS NULL OR unidentified >= 0)',
  'by_channel jsonb',
];

module.exports = {
  up: async (queryInterface) => {
    for (const column of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."rm_mkt_frequency" ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const column of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."rm_mkt_frequency" DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
