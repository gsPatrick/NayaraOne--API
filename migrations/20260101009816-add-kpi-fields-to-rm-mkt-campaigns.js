'use strict';

/**
 * Marco 9, demanda M9-D670 (KPIs de Marketing: campanhas, custo, leads e atribuição): campos da campanha que o KPI "Campanhas ativas e encerradas"
 * precisa no read model rm_mkt_campaigns da M9-D627. Nenhuma tabela nova: RLS, FORCE e GRANT continuam os da migration 9733. Idempotente.
 * Faixa reservada: 9816 a 9823.
 *   channels        canais da campanha (a campanha sem canal deixa o KPI DEGRADED)
 *   state           estado da campanha (DRAFT, SCHEDULED, RUNNING, ENDED)
 *   started_on      dia de São Paulo do início previsto
 *   ended_on        dia de São Paulo do fim, só quando a campanha está ENCERRADA
 *   has_cost_link   a campanha tem centro de custo (código igual ao dela) ou lançamento ligado a ela (regra de qualidade do custo)
 * Todos nascem NULOS e valem no próximo evento ou rebuild do read model: nulo quer dizer "ainda não calculado" e o KPI não mostra valor.
 */
const COLUMNS = [
  'channels text[]',
  'state varchar(12) CHECK (state IS NULL OR state IN (\'DRAFT\', \'SCHEDULED\', \'RUNNING\', \'ENDED\'))',
  'started_on date',
  'ended_on date',
  'has_cost_link boolean',
];

module.exports = {
  up: async (queryInterface) => {
    for (const column of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."rm_mkt_campaigns" ADD COLUMN IF NOT EXISTS ${column}`);
  },

  down: async (queryInterface) => {
    for (const column of COLUMNS) await queryInterface.sequelize.query(`ALTER TABLE "analytics"."rm_mkt_campaigns" DROP COLUMN IF EXISTS ${column.split(' ')[0]}`);
  },
};
