'use strict';

/**
 * M9-D687 — abrir e publicar painéis do BI.
 *
 * Abrir (GET /analytics/dashboards/:code): regra única de status (a mesma da M9-D700): sem `analytics:read` = 403; painel
 * inexistente ou despublicado = 404 ANALYTICS_DASHBOARD_NOT_FOUND; sem a `required_permission` do painel = 403 PERMISSION_DENIED
 * com a permissão ausente. A empresa pode ter versão própria (ou do grupo) do painel: vale a mais específica; senão, o catálogo
 * global. Só devolve a composição (widgets); os valores vêm do registro de métricas. Registra o acesso (painel CRITICAL).
 * Publicar (POST): `analytics:manage`; cria version+1 em DRAFT, grava os widgets e publica (fecha a anterior) numa transação.
 */
const AppError = require('../../../utils/AppError');
const store = require('../../../features/analytics/dashboardStore.service');
const readStore = require('../../../features/analytics/dashboardReadStore.service');
const metricStore = require('../../../features/analytics/metricStore.service');
const { assertPermission, P, recordAccess, readParam, KEYS } = require('../security');

const notFound = () => AppError.notFound('Painel não encontrado.', 'ANALYTICS_DASHBOARD_NOT_FOUND');
const CODE_RE = /^[a-z][a-z0-9_]*$/;
const PUBLISH_SCOPES = ['COMPANY', 'GROUP'];

function toWidgetView(w) {
  return {
    position: w.position, type: w.widget_type, metricCode: w.metric_code, dimensionKey: w.dimension_key, title: w.title,
    valueNature: w.value_nature, drilldownEnabled: w.drilldown_enabled, config: w.config,
  };
}

function toView(dash, widgets) {
  return {
    dashboardCode: dash.dashboard_code, name: dash.name, description: dash.description, domain: dash.domain, version: dash.version,
    status: dash.status, publishedAt: dash.published_at, p95TargetMs: dash.p95_target_ms, requiredPermission: dash.required_permission,
    audienceRoles: dash.audience_roles, layout: dash.layout, widgets: widgets.map(toWidgetView),
  };
}

async function openDashboard(ctx, code, { ip = null, route = null } = {}, transaction) {
  assertPermission(ctx, P.READ);
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw notFound();
  const dash = await readStore.findPublishedDashboard({ code, companyId: ctx.companyId, groupId: ctx.groupId }, transaction);
  if (!dash) throw notFound();
  assertPermission(ctx, dash.required_permission);
  const { widgets } = await store.getDashboardWithWidgets(dash.id, transaction);
  const mode = await readParam(KEYS.PANEL_OPEN_LOG, ctx, transaction);
  if (mode === 'TODOS' || await readStore.dashboardHasCriticalMetric(dash.id, transaction)) {
    await recordAccess(ctx, {
      action: 'DASHBOARD_OPEN', resourceType: 'DASHBOARD', resourceCode: code, route, ip, filters: { version: dash.version }, rowsReturned: widgets.length,
    });
  }
  return toView(dash, widgets);
}

function validateBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const scopeLevel = b.scopeLevel || 'COMPANY';
  if (!PUBLISH_SCOPES.includes(scopeLevel)) {
    throw AppError.badRequest('O catálogo global só é alterado por migration; publique para a empresa ou para o grupo.', 'ANALYTICS_DASHBOARD_INVALID');
  }
  if (!Array.isArray(b.widgets) || !b.widgets.length) throw AppError.badRequest('Informe os widgets do painel.', 'ANALYTICS_DASHBOARD_INVALID');
  return { ...b, scopeLevel };
}

async function publishDashboardVersion(ctx, body, transaction) {
  assertPermission(ctx, P.MANAGE);
  const input = validateBody(body);
  if (input.scopeLevel === 'GROUP') assertPermission(ctx, P.READ_GROUP);
  await metricStore.enableAnalyticsWriter(transaction);
  const p95 = input.p95TargetMs ?? Number(await readParam(KEYS.P95_DEFAULT_MS, ctx, transaction));
  const draft = await store.createDashboardDefinition({
    scopeLevel: input.scopeLevel, groupId: ctx.groupId, companyId: input.scopeLevel === 'COMPANY' ? ctx.companyId : null,
    dashboardCode: input.dashboardCode, name: input.name, description: input.description, domain: input.domain,
    audienceRoles: input.audienceRoles, layout: input.layout, requiredPermission: input.requiredPermission, p95TargetMs: p95,
  }, ctx, transaction);
  for (const [position, widget] of input.widgets.entries()) {
    await store.addDashboardWidget(draft.id, { ...widget, position: widget.position ?? position }, ctx, transaction);
  }
  const published = await store.publishDashboard(draft.id, ctx, transaction);
  const full = await store.getDashboardWithWidgets(published.id, transaction);
  return toView(full, full.widgets);
}

module.exports = { openDashboard, publishDashboardVersion };
