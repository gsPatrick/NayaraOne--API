'use strict';

/**
 * Marco 9, demanda M9-D673: conteúdo dos painéis Marketing (`marketing`) e Atendimento/Satisfação (`support`) publicado como nova versão das definições globais (M9-D687), com a
 * permissão do domínio de cada um (`marketing:attribution:read` e `crm:feedback:read`, o mapa domínio x permissão da M9-D700/M9-D690; a rota exige também `analytics:read`).
 * Sem tabela nova. Idempotente e reversível. Faixa de migrations desta demanda: 9883 a 9890.
 */
const { publishPanelVersion, unpublishPanelVersion } = require('../src/features/analytics/dashboards/dashboard.seedVersion');
const { MARKETING_PANEL, SUPPORT_PANEL } = require('../src/features/analytics/dashboards/panels');

const MARKETING_DESCRIPTION = 'Painel Marketing do BI: campanhas, custo, leads, atribuição, entregabilidade, opt-out, frequência e automações. Conteúdo publicado pela demanda M9-D673.';
const SUPPORT_DESCRIPTION = 'Painel Atendimento/Satisfação do BI: reviews, satisfação, reclamações por motivo e SLA de resolução. Conteúdo publicado pela demanda M9-D673.';

module.exports = {
  up: async (queryInterface) => {
    await publishPanelVersion(queryInterface, { ...MARKETING_PANEL, description: MARKETING_DESCRIPTION, requiredPermission: 'marketing:attribution:read' });
    await publishPanelVersion(queryInterface, { ...SUPPORT_PANEL, description: SUPPORT_DESCRIPTION, requiredPermission: 'crm:feedback:read' });
  },
  down: async (queryInterface) => {
    await unpublishPanelVersion(queryInterface, SUPPORT_PANEL);
    await unpublishPanelVersion(queryInterface, MARKETING_PANEL);
  },
};
