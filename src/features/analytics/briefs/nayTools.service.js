'use strict';

/**
 * M9-D695 — serviço das ferramentas da NAY Diretoria: `createNayAnalytics(transaction, scope)` devolve as 7 funções de leitura ligadas à
 * transação do tenant e ao escopo do chamador { groupId, companyId, userId, permissions, userPermissions }. O agente roda SEM string de
 * conexão: só este serviço, no servidor, lê o schema analytics. Cada função recebe o objeto de entrada já validado pelo schema da tool.
 */
const metric = require('./nayTools.metric');
const board = require('./nayTools.board');

function createNayAnalytics(transaction, scope) {
  const bind = (fn) => (input = {}) => fn(scope, input || {}, transaction);
  return {
    getMetric: bind(metric.getMetric),
    getMetricVariation: bind(metric.getMetricVariation),
    getMetricBreakdown: bind(metric.getMetricBreakdown),
    listAlerts: bind(board.listAlerts),
    getSourceRefs: bind(metric.getSourceRefs),
    getDashboardSummary: bind(board.getDashboardSummary),
    getFreshness: bind(metric.getFreshness),
  };
}

module.exports = { createNayAnalytics };
