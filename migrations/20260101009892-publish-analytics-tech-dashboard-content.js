'use strict';

/**
 * Marco 9, demanda M9-D682: conteúdo do painel Segurança/Integrações/IA (`tech`) publicado como nova versão da definição global (M9-D687): a faixa de qualidade e os 11 indicadores
 * técnicos na ordem do livro, com o quadro de integrações por fornecedor, ambiente e família. Sem tabela nova. Idempotente. Faixa de migrations do bloco: 9891 a 9898.
 */
const { publishPanelVersion, unpublishPanelVersion } = require('../src/features/analytics/dashboards/dashboard.seedVersion');
const { TECH_PANEL } = require('../src/features/analytics/dashboards/panels/tech.panel');

const DESCRIPTION = 'Painel Segurança/Integrações/IA do BI: disponibilidade, freshness, filas, integrações por fornecedor, ambiente e família, autenticação, bloqueios e a IA (custo, orçamento, qualidade e chamadas bloqueadas). Conteúdo publicado pela demanda M9-D682.';

module.exports = {
  up: async (queryInterface) => {
    await publishPanelVersion(queryInterface, { ...TECH_PANEL, description: DESCRIPTION });
  },
  down: async (queryInterface) => {
    await unpublishPanelVersion(queryInterface, TECH_PANEL);
  },
};
