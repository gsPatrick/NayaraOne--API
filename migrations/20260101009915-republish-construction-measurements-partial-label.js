'use strict';

/**
 * Marco 9 (rodada 3 do aceite da Nayara, item 1 — Medições): republica o painel Obras (`construction`)
 * como nova versão para incluir o rótulo "Total parcial" no indicador de Medições (horizonText), deixando
 * claro na tela que o headline soma só as obras já materializadas e que o detalhamento abre a empresa inteira
 * no mesmo recorte de status. Sem tabela nova. Idempotente: publishPanelVersion só cria version+1 se o
 * conteúdo mudou (mudou — horizonText adicionado em construction.panel.js).
 */
const { publishPanelVersion, unpublishPanelVersion } = require('../src/features/analytics/dashboards/dashboard.seedVersion');
const { CONSTRUCTION_PANEL } = require('../src/features/analytics/dashboards/panels');

const PANEL = {
  ...CONSTRUCTION_PANEL,
  description: 'Painel Obras do BI: avanço x cronograma, atrasos, linha de base x realizado x projetada, margem projetada, medições (com rótulo de total parcial x detalhe), não conformidades e desperdício. Rótulo de recorte publicado na rodada 3 do aceite do Marco 9.',
};

module.exports = {
  up: async (queryInterface) => {
    await publishPanelVersion(queryInterface, PANEL);
  },
  down: async (queryInterface) => {
    await unpublishPanelVersion(queryInterface, PANEL);
  },
};
