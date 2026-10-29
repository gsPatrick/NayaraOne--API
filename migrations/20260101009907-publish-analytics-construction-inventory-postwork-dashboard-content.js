'use strict';

/**
 * Marco 9, demanda M9-D654: conteúdo dos painéis Obras (`construction`), Estoque/Patrimônio (`inventory`) e Pós-obra (`postwork`) publicado como nova versão
 * das definições globais (M9-D687). Sem tabela nova. Idempotente. Faixa de migrations do bloco: 9907 a 9914.
 */
const { publishPanelVersion, unpublishPanelVersion } = require('../src/features/analytics/dashboards/dashboard.seedVersion');
const { CONSTRUCTION_PANEL, INVENTORY_PANEL, POSTWORK_PANEL } = require('../src/features/analytics/dashboards/panels');

const PANELS = [
  { ...CONSTRUCTION_PANEL, description: 'Painel Obras do BI: avanço x cronograma, atrasos, linha de base x realizado x projetada, margem projetada, medições, não conformidades e desperdício. Conteúdo publicado pela demanda M9-D654.' },
  { ...INVENTORY_PANEL, description: 'Painel Estoque/Patrimônio do BI: valor em estoque, itens abaixo do mínimo, perdas e ferramentas em atraso. Conteúdo publicado pela demanda M9-D654.' },
  { ...POSTWORK_PANEL, description: 'Painel Pós-obra do BI: custo pós-obra (realizado e previsto) e recorrência de problemas por causa, equipe e material. Conteúdo publicado pela demanda M9-D654.' },
];

module.exports = {
  up: async (queryInterface) => {
    for (const panel of PANELS) await publishPanelVersion(queryInterface, panel);
  },
  down: async (queryInterface) => {
    for (const panel of [...PANELS].reverse()) await unpublishPanelVersion(queryInterface, panel);
  },
};
