'use strict';

/**
 * Marco 9, demanda M9-D634: conteúdo do painel Vendas/CRM (`crm`) publicado como nova versão da definição global (M9-D687): faixa de qualidade e os 14
 * indicadores de CRM, imóveis e Radar na ordem do livro. Sem tabela nova (RLS e GRANT já valem para as do schema analytics). Idempotente. Faixa de
 * migrations do bloco: 9834 a 9841.
 */
const { publishPanelVersion, unpublishPanelVersion } = require('../src/features/analytics/dashboards/dashboard.seedVersion');
const { CRM_PANEL } = require('../src/features/analytics/dashboards/panels');

const DESCRIPTION = 'Painel Vendas/CRM do BI: funil, carteira de imóveis, Radar e desempenho comercial. Conteúdo publicado pela demanda M9-D634.';

module.exports = {
  up: (queryInterface) => publishPanelVersion(queryInterface, { ...CRM_PANEL, description: DESCRIPTION }),
  down: (queryInterface) => unpublishPanelVersion(queryInterface, CRM_PANEL),
};
