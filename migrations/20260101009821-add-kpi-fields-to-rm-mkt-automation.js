'use strict';

/**
 * Marco 9, demanda M9-D671 (KPIs de Marketing: automações bloqueadas e com falha): campos que o KPI precisa no read model rm_mkt_automation da M9-D627.
 * Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da migration 9733. Idempotente. Faixa reservada: 9816 a 9823.
 *   blocked_without_reason  execuções bloqueadas sem `blocked_reason` (regra de qualidade: DEGRADED)
 *   blocked_by_reason       { motivo: quantidade } das bloqueadas do dia (QUIET_HOURS é adiamento, não bloqueio, e não entra)
 *   failed_by_code          { código de erro: quantidade } das com falha do dia ("SEM_CODIGO" quando a execução não traz o código)
 *   by_automation           { automação: { executed, blocked, failed } } do dia
 * Nascem NULOS e valem no próximo evento, na agenda ou no rebuild: nulo quer dizer "ainda não calculado" e o KPI não mostra valor.
 */
const COLUMNS = [
  'blocked_without_reason integer CHECK (blocked_without_reason IS NULL OR blocked_without_reason >= 0)',
  'blocked_by_reason jsonb',
  'failed_by_code jsonb',
  'by_automation jsonb',
];

module.exports = {
  up: async (queryInterface) => {
    for (const column of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."rm_mkt_automation" ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const column of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."rm_mkt_automation" DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
