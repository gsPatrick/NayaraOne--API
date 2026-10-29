'use strict';

/**
 * Marco 9, demanda M9-D685: conteúdo do painel Centro de Comando (`command_center`) publicado como nova versão da definição global (M9-D687): a faixa de qualidade, o
 * briefing da NAY Diretoria e os seis blocos do livro, cada um com as métricas de que depende. Sem tabela nova. Idempotente e reversível. Depende da 9910.
 */
const { publishPanelVersion, unpublishPanelVersion } = require('../src/features/analytics/dashboards/dashboard.seedVersion');
const { COMMAND_CENTER_PANEL } = require('../src/features/analytics/dashboards/panels/commandCenter.panel');

const PANEL = {
  ...COMMAND_CENTER_PANEL,
  description: 'Centro de Comando da Diretoria: o que aconteceu, o que exige decisão, onde há risco, onde há dinheiro parado ou perdido, quais prazos estão críticos e quais oportunidades merecem atenção. Conteúdo publicado pela demanda M9-D685.',
};

module.exports = {
  up: async (queryInterface) => publishPanelVersion(queryInterface, PANEL),
  down: async (queryInterface) => unpublishPanelVersion(queryInterface, PANEL),
};
