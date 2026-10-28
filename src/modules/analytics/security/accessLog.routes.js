'use strict';

/** M9-D700 (3.5) — GET /analytics/access-log: leitura do log de acesso, só com analytics:audit:read. */
const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { P } = require('./permissionCatalog');
const { requireAnalyticsPermission } = require('./permissionGuard');
const { listAccessLog } = require('./accessLog');

function registerAccessLogRoutes(router) {
  router.get('/analytics/access-log', requireAnalyticsPermission(P.AUDIT_READ), catchAsync(async (req, res) => {
    const ctx = { groupId: req.auth.groupId, companyId: req.auth.companyId, actorUserId: req.auth.userId, permissions: req.auth.permissions };
    const { action, userId, from, to } = req.query;
    const limit = req.query.limit ? Number(req.query.limit) : null;
    const data = await req.withTenantTransaction((tx) => listAccessLog(ctx, { action, userId, from, to, limit }, tx));
    return success(res, { data });
  }));
}

module.exports = { registerAccessLogRoutes };
