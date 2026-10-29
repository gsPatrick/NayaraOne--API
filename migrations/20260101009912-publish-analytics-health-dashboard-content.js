'use strict';

/**
 * Marco 9, demanda M9-D686: conteúdo do painel Saúde Geral (`health`) publicado como nova versão da definição global (M9-D687): a faixa de qualidade e, por área, os três KPIs
 * principais com a regra de semáforo de cada um (`config.trafficLight`, padrões do livro/CSV). Sem tabela nova. Idempotente e reversível. A versão da empresa nasce dos
 * parâmetros dela por `POST /analytics/dashboards/health/thresholds`. Faixa do grupo BI: 9910 a 9917.
 */
const { publishPanelVersion, unpublishPanelVersion } = require('../src/features/analytics/dashboards/dashboard.seedVersion');
const { HEALTH_PANEL } = require('../src/features/analytics/dashboards/panels/health.panel');

const PANEL = {
  ...HEALTH_PANEL,
  description: 'Saúde Geral: uma linha por área com um semáforo derivado dos alertas abertos, da qualidade do dado e dos limites de cada KPI. Conteúdo publicado pela demanda M9-D686.',
};

module.exports = {
  up: async (queryInterface) => publishPanelVersion(queryInterface, PANEL),
  down: async (queryInterface) => unpublishPanelVersion(queryInterface, PANEL),
};
