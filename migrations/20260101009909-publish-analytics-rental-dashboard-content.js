'use strict';

/**
 * Marco 9, demanda M9-D643: conteúdo do painel Locação (`rental`) publicado como nova versão da definição global (M9-D687), com a permissão do domínio
 * `legal:read` (a rota exige também `analytics:read`). Sem tabela nova. Idempotente e reversível. Faixa de migrations do bloco: 9908 a 9915.
 */
const { publishPanelVersion, unpublishPanelVersion } = require('../src/features/analytics/dashboards/dashboard.seedVersion');
const { RENTAL_PANEL } = require('../src/features/analytics/dashboards/panels');

const PANEL = {
  ...RENTAL_PANEL,
  description: 'Painel Locação do BI: contratos ativos, vacância, inadimplência, garantias a vencer, obrigações pendentes, vistorias e chaves, chamados, satisfação e repasses. Conteúdo publicado pela demanda M9-D643.',
  requiredPermission: 'legal:read',
};

module.exports = {
  up: async (queryInterface) => publishPanelVersion(queryInterface, PANEL),
  down: async (queryInterface) => unpublishPanelVersion(queryInterface, PANEL),
};
