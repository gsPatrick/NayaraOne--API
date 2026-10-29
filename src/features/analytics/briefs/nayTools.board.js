'use strict';

/**
 * M9-D695 — ferramentas da NAY Diretoria sobre alertas e painéis: listAlerts e getDashboardSummary. Alertas e widgets de domínio que o
 * usuário não pode ver somem da resposta (sem revelar que existem). O painel só devolve a composição e o último número de cada widget.
 */
const AppError = require('../../../utils/AppError');
const { findDefinition, readMetricAsOf, clock } = require('../metrics');
const store = require('../nayReadStore.service');
const readStore = require('../dashboardReadStore.service');
const dashboardStore = require('../dashboardStore.service');
const { assertPermission } = require('../security');
const { readMaxItems } = require('../nayToolsSettings');
const { biContext, assertBiRead, companyOf, visibleDomains, secureRows, forbidden } = require('./nayTools.access');

const notFound = () => AppError.notFound('Painel não encontrado.', 'ANALYTICS_DASHBOARD_NOT_FOUND');

async function listAlerts(scope, input, transaction) {
  const ctx = biContext(scope);
  await assertBiRead(ctx);
  const companyId = await companyOf(ctx, input.companyId, transaction);
  const max = await readMaxItems(ctx, transaction);
  const found = await store.listAlertInstances({ companyId, status: input.status, severity: input.severity, limit: max + 1 }, transaction);
  const visible = await visibleDomains(ctx, found.map((a) => a.domain), transaction);
  const allowed = found.filter((a) => !a.domain || visible.has(a.domain));
  const items = allowed.slice(0, max).map((a) => ({
    alertId: a.id, alertCode: a.alertCode, metricCode: a.metricCode, status: a.status, severity: a.severity, openedAt: a.openedAt,
    acknowledgedAt: a.acknowledgedAt, resolvedAt: a.resolvedAt, lastEvaluatedAt: a.lastEvaluatedAt,
    lastValue: a.lastValue === null || a.lastValue === undefined ? null : String(a.lastValue), occurrenceCount: a.occurrenceCount,
  }));
  const row = { items, truncated: allowed.length > max };
  return (await secureRows(ctx, { tool: 'listAlerts', filters: { status: input.status || null, severity: input.severity || null }, rows: [row] }, transaction))[0];
}

/** Número mais recente do widget na data de hoje; sem número gravado, o widget sai sem valor (nunca estimado). */
async function widgetValue(ctx, companyId, widget, definition, transaction) {
  try {
    const r = await readMetricAsOf(ctx, { metricCode: widget.metric_code, scopeType: 'COMPANY', scopeId: companyId, asOfDate: clock.businessToday() }, transaction);
    return { value: r.value, unit: r.unit, status: r.status, valueNature: r.valueNature, asOfDate: r.asOfDate, freshness: r.freshness };
  } catch (err) {
    if (err && err.code === 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE') return { value: null, unit: null, status: 'SEM_DADOS', valueNature: definition.value_nature || null, asOfDate: null, freshness: null };
    throw err;
  }
}

async function getDashboardSummary(scope, input, transaction) {
  const ctx = biContext(scope);
  await assertBiRead(ctx);
  const companyId = await companyOf(ctx, input.companyId, transaction);
  const dash = await readStore.findPublishedDashboard({ code: input.dashboardCode, companyId, groupId: ctx.groupId }, transaction);
  if (!dash) throw notFound();
  try {
    assertPermission(ctx, dash.required_permission);
  } catch (err) {
    throw forbidden(dash.required_permission);
  }
  const { widgets } = await dashboardStore.getDashboardWithWidgets(dash.id, transaction);
  const defs = new Map();
  for (const w of widgets.filter((x) => x.metric_code)) {
    try { defs.set(w.metric_code, await findDefinition(w.metric_code, transaction)); } catch (err) { if (err.code !== 'ANALYTICS_METRIC_NOT_FOUND') throw err; }
  }
  const visible = await visibleDomains(ctx, [...defs.values()].map((d) => d.domain), transaction);
  const items = [];
  for (const w of widgets) {
    const def = w.metric_code ? defs.get(w.metric_code) : null;
    if (w.metric_code && (!def || !visible.has(def.domain))) continue;
    items.push({
      position: w.position, type: w.widget_type, title: w.title, metricCode: w.metric_code || null,
      ...(def ? await widgetValue(ctx, companyId, w, def, transaction) : { value: null, unit: null, status: null, valueNature: null, asOfDate: null, freshness: null }),
    });
  }
  const row = { dashboardCode: dash.dashboard_code, name: dash.name, domain: dash.domain, version: dash.version, widgets: items };
  return (await secureRows(ctx, { tool: 'getDashboardSummary', resourceCode: dash.dashboard_code, filters: {}, rows: [row] }, transaction))[0];
}

module.exports = { listAlerts, getDashboardSummary };
