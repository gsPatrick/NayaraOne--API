'use strict';

/**
 * Marco 9, demanda M9-D662: conteúdo dos painéis Jurídico (`legal`) e Correspondente (`correspondent`) publicado como nova versão das definições globais
 * (M9-D687). Sem tabela nova. Idempotente. Faixa de migrations do bloco: 9834 a 9841.
 */
const { publishPanelVersion, unpublishPanelVersion } = require('../src/features/analytics/dashboards/dashboard.seedVersion');
const { LEGAL_PANEL, CORRESPONDENT_PANEL } = require('../src/features/analytics/dashboards/panels');

const LEGAL_DESCRIPTION = 'Painel Jurídico do BI: prazos, processos por risco, valores e documentos faltantes (agregados). Conteúdo publicado pela demanda M9-D662.';
const COR_DESCRIPTION = 'Painel Correspondente do BI: casos por estágio, aprovação por provider, tempo de análise e comissão. Conteúdo publicado pela demanda M9-D662.';

module.exports = {
  up: async (queryInterface) => {
    await publishPanelVersion(queryInterface, { ...LEGAL_PANEL, description: LEGAL_DESCRIPTION });
    await publishPanelVersion(queryInterface, { ...CORRESPONDENT_PANEL, description: COR_DESCRIPTION });
  },
  down: async (queryInterface) => {
    await unpublishPanelVersion(queryInterface, CORRESPONDENT_PANEL);
    await unpublishPanelVersion(queryInterface, LEGAL_PANEL);
  },
};
