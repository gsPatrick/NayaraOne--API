'use strict';

/**
 * M9-D703 — GET /analytics/alerts (analytics:read; ABAC por domínio no serviço) e POST /analytics/alerts/:id/ack (analytics:alert:ack; ser o responsável ou ter
 * analytics:alert:manage no serviço). Registradas no router de /analytics DEPOIS da guarda de método e da transação somente leitura (M9-D612); o ack é uma das duas
 * escritas de usuário permitidas ao BI (ANALYTICS_WRITE_ROUTES) e grava só em analytics.alert_instances.
 */
const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { P } = require('../security/permissionCatalog');
const { requireAnalyticsPermission } = require('../security/permissionGuard');
const { listAlerts } = require('./list.service');
const { acknowledgeAlert } = require('./ack.service');

const ctxOf = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, actorUserId: req.auth.userId, permissions: req.auth.permissions });

function registerAlertRoutes(router) {
  router.get('/analytics/alerts', requireAnalyticsPermission(P.READ), catchAsync(async (req, res) => {
    const data = await req.withTenantTransaction((tx) => listAlerts(ctxOf(req), req.query, tx));
    return success(res, { data });
  }));
  router.post('/analytics/alerts/:id/ack', requireAnalyticsPermission(P.ALERT_ACK), catchAsync(async (req, res) => {
    const data = await req.withTenantTransaction((tx) => acknowledgeAlert(ctxOf(req), req.params.id, { ip: req.ip }, tx));
    return success(res, { data });
  }));
}

module.exports = { registerAlertRoutes };
