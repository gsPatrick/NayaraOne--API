'use strict';

/**
 * M9-D686 (3.3, BI-008) — "mudar um limiar cria nova versão do painel". Os parâmetros do administrador (`analytics.semaforo.*` e `analytics.saude.kpis_por_area`) não
 * mudam a cor de nada sozinhos: `POST /analytics/dashboards/health/thresholds` (analytics:manage) monta os widgets com os valores vigentes da empresa e, se diferem da versão
 * em vigor, publica a versão da EMPRESA (a anterior fica no histórico, M9-D687). Sem diferença, nada é gravado e a resposta diz que nada mudou.
 */
const readStore = require('../../dashboardReadStore.service');
const store = require('../../dashboardStore.service');
const { readHealthParams } = require('../../healthSettings');
const { buildHealthWidgets } = require('./health.widgets');
const { publishDashboardVersion } = require('../dashboard.service');

const CODE = 'health';
const stable = (value) => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const shapeOf = (w) => ({ widgetType: w.widgetType || w.widget_type, metricCode: w.metricCode || w.metric_code || null, config: w.config || {} });

async function applyHealthThresholds(ctx, tx) {
  const params = await readHealthParams(ctx, tx);
  const wanted = buildHealthWidgets(params.areas, params.rules);
  const current = await readStore.findPublishedDashboard({ code: CODE, companyId: ctx.companyId, groupId: ctx.groupId }, tx);
  const { widgets } = await store.getDashboardWithWidgets(current.id, tx);
  if (stable(widgets.map(shapeOf)) === stable(wanted.map(shapeOf))) return { changed: false, version: current.version, dashboardCode: CODE };
  const published = await publishDashboardVersion(ctx, {
    scopeLevel: 'COMPANY', dashboardCode: CODE, name: current.name, description: current.description, domain: current.domain, audienceRoles: current.audience_roles, layout: current.layout,
    requiredPermission: current.required_permission, p95TargetMs: current.p95_target_ms, widgets: wanted.map((w, position) => ({ ...w, position })),
  }, tx);
  return { changed: true, version: published.version, previousVersion: current.version, dashboardCode: CODE };
}

module.exports = { applyHealthThresholds };
