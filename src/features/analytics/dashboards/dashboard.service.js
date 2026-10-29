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
const store = require('../dashboardStore.service');
const readStore = require('../dashboardReadStore.service');
const metricStore = require('../metricStore.service');
const { assertPermission, P, recordAccess, readParam, KEYS } = require('../security');
const { cached } = require('./cache');
const { composeWidgets, toWidgetView } = require('./dashboard.compose');
const clock = require('../metrics/clock');
const { defaultPeriodOf, periodView } = require('../metrics/query.period');

const notFound = () => AppError.notFound('Painel não encontrado.', 'ANALYTICS_DASHBOARD_NOT_FOUND');
const CODE_RE = /^[a-z][a-z0-9_]*$/;
const PUBLISH_SCOPES = ['COMPANY', 'GROUP'];

function toView(dash, widgets) {
  return {
    dashboardCode: dash.dashboard_code, name: dash.name, description: dash.description, domain: dash.domain, version: dash.version,
    status: dash.status, publishedAt: dash.published_at, p95TargetMs: dash.p95_target_ms, requiredPermission: dash.required_permission,
    audienceRoles: dash.audience_roles, layout: dash.layout, widgets: widgets.map(toWidgetView),
  };
}

/** Painel aberto: a definição mais os valores prontos de cada widget na data-base (M9-D634): widgets, resumo de qualidade e instante da composição. */
async function toOpenView(ctx, dash, asOfDate, period, transaction) {
  const { widgets } = await store.getDashboardWithWidgets(dash.id, transaction);
  const composed = await composeWidgets(ctx, widgets, asOfDate, transaction, period);
  return { ...toView(dash, []), widgets: composed.widgets, asOfDate, period: periodView(period, asOfDate), generatedAt: clock.now().toISOString(), quality: composed.quality };
}

async function openDashboard(ctx, code, { ip = null, route = null, asOfDate = clock.businessToday(), period = defaultPeriodOf(asOfDate) } = {}, transaction) {
  assertPermission(ctx, P.READ);
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw notFound();
  const dash = await readStore.findPublishedDashboard({ code, companyId: ctx.companyId, groupId: ctx.groupId }, transaction);
  if (!dash) throw notFound();
  assertPermission(ctx, dash.required_permission);
  // Cache por permissão e escopo (M9-D698 3.3): a conferência de permissão acima e o log abaixo valem em TODA abertura, com ou sem cache.
  const view = await cached(ctx, { dashboardCode: code, period: `${period.startDate}:${period.endDate}:${asOfDate}`, version: dash.version }, () => toOpenView(ctx, dash, asOfDate, period, transaction), { transaction });
  const mode = await readParam(KEYS.PANEL_OPEN_LOG, ctx, transaction);
  if (mode === 'TODOS' || await readStore.dashboardHasCriticalMetric(dash.id, transaction)) {
    await recordAccess(ctx, {
      action: 'DASHBOARD_OPEN', resourceType: 'DASHBOARD', resourceCode: code, route, ip, filters: { version: dash.version }, rowsReturned: view.widgets.length,
    });
  }
  return view;
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
  // Meta p95 obrigatória (M9-D698 3.5): a coluna p95_target_ms é a única fonte; não há valor padrão.
  const p95 = input.p95TargetMs;
  if (!Number.isInteger(p95) || p95 <= 0) throw AppError.unprocessable('Defina a meta de tempo (p95) do painel.', 'ANALYTICS_DASHBOARD_NO_P95');
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
