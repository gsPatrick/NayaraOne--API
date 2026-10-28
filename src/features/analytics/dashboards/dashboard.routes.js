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

const ctxOf = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, actorUserId: req.auth.userId, permissions: req.auth.permissions });

function registerDashboardRoutes(router) {
  router.get('/analytics/dashboards/:code', requireAnalyticsPermission(P.READ), catchAsync(async (req, res) => {
    const data = await req.withTenantTransaction((tx) => openDashboard(ctxOf(req), req.params.code, { ip: req.ip, route: 'GET /analytics/dashboards/:code' }, tx));
    return success(res, { data });
  }));
  router.post('/analytics/dashboards', requireAnalyticsPermission(P.MANAGE), catchAsync(async (req, res) => {
    const data = await req.withTenantTransaction((tx) => publishDashboardVersion(ctxOf(req), req.body, tx));
    return success(res, { statusCode: 201, data });
  }));
}

module.exports = { registerDashboardRoutes };
