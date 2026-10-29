'use strict';

// M9-D695 (3.1) — os nomes do catálogo fechado da NAY Diretoria. Arquivo sem dependências (o guarda e o catálogo leem daqui).
const BI_TOOL_PREFIX = 'analytics.';
const NAY_TOOL_NAMES = Object.freeze([
  'analytics.getMetric', 'analytics.getMetricVariation', 'analytics.getMetricBreakdown', 'analytics.listAlerts',
  'analytics.getSourceRefs', 'analytics.getDashboardSummary', 'analytics.getFreshness',
]);

module.exports = { BI_TOOL_PREFIX, NAY_TOOL_NAMES };
