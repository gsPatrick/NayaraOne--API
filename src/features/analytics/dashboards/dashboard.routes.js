'use strict';

/**
 * M9-D687 — rotas de painéis do BI, registradas no router de /analytics DEPOIS da guarda de método e da transação somente
 * leitura (M9-D612). Cada rota exige permissão do catálogo (M9-D700); a permissão do painel é conferida no serviço.
 */
const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { P } = require('../security/permissionCatalog');
const { requireAnalyticsPermission } = require('../security/permissionGuard');
const { openDashboard, publishDashboardVersion } = require('./dashboard.service');
const { resolveQueryPeriod } = require('../metrics/query.period');
const { DASHBOARD_PARAMS, assertKnownParams } = require('../metrics/query.params');
const { resolveCompanyScope } = require('../security');
const { applyHealthThresholds } = require('./health/health.apply');

const ctxOf = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, actorUserId: req.auth.userId, permissions: req.auth.permissions });

function registerDashboardRoutes(router) {
  router.get('/analytics/dashboards/:code', requireAnalyticsPermission(P.READ), catchAsync(async (req, res) => {
    assertKnownParams(req.query, DASHBOARD_PARAMS); // M9-D702 3.3: erro de digitação é 400 ANALYTICS_QUERY_PARAM_UNKNOWN
    const { period, asOfDate } = resolveQueryPeriod(req.query); // M9-D606: calendário de São Paulo; futuro é 400 ANALYTICS_AS_OF_FUTURE
    const data = await req.withTenantTransaction(async (tx) => {
      await resolveCompanyScope(ctxOf(req), req.query.companyId, tx); // outro grupo ou sem vínculo: 404 ANALYTICS_SCOPE_NOT_FOUND
      return openDashboard(ctxOf(req), req.params.code, { ip: req.ip, route: 'GET /analytics/dashboards/:code', asOfDate, period, block: typeof req.query.bloco === 'string' ? req.query.bloco : null }, tx);
    });
    return success(res, { data });
  }));
  router.post('/analytics/dashboards/health/thresholds', requireAnalyticsPermission(P.MANAGE), catchAsync(async (req, res) => { // M9-D686: limiar mudou = nova versão do painel
    const data = await req.withTenantTransaction((tx) => applyHealthThresholds(ctxOf(req), tx));
    return success(res, { statusCode: data.changed ? 201 : 200, data });
  }));
  router.post('/analytics/dashboards', requireAnalyticsPermission(P.MANAGE), catchAsync(async (req, res) => {
    const data = await req.withTenantTransaction((tx) => publishDashboardVersion(ctxOf(req), req.body, tx));
    return success(res, { statusCode: 201, data });
  }));
}

module.exports = { registerDashboardRoutes };
