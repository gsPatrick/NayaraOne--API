'use strict';

/**
 * Marco 9, demanda M9-D626: conteúdo do painel Financeiro (`finance`) publicado como nova versão da definição global (M9-D687), com a permissão do domínio
 * `finance:read` (a rota exige também `analytics:read`). Sem tabela nova. Idempotente e reversível. Faixa de migrations desta demanda: 9908 a 9915.
 */
const { publishPanelVersion, unpublishPanelVersion } = require('../src/features/analytics/dashboards/dashboard.seedVersion');
const { FINANCE_PANEL } = require('../src/features/analytics/dashboards/panels');

const PANEL = {
  ...FINANCE_PANEL,
  description: 'Painel Financeiro do BI: caixa livre, dinheiro de terceiros, necessidade para respirar, contas a pagar e a receber em 7, 30 e 60 dias, inadimplência, margem por setor, comissões, repasses, conciliações e anomalias. Conteúdo publicado pela demanda M9-D626.',
  requiredPermission: 'finance:read',
};

module.exports = {
  up: async (queryInterface) => publishPanelVersion(queryInterface, PANEL),
  down: async (queryInterface) => unpublishPanelVersion(queryInterface, PANEL),
};
