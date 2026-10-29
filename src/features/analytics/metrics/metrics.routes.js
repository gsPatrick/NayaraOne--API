'use strict';

const { Router } = require('express');
const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { P } = require('../security/permissionCatalog');
const { requireAnalyticsPermission } = require('../security/permissionGuard');
const { readMetricResponse } = require('./query.service');

/**
 * GET /analytics/metrics/:code (M9-D702): valor pronto, qualidade, freshness e fonte de um indicador, por período (`period`, `month`, `quarter`, `year`,
 * `from`/`to`), data-base (`asOf`, M9-D604), dimensão, comparação (`compareTo`, M9-D694) ou consolidado do grupo (`groupId`, M9-D625). O contrato, as
 * validações e os erros estão em query.service.js; a rota só entrega o contexto do usuário.
 */
const getMetric = catchAsync(async (req, res) => {
  const { companyId, groupId, permissions, userId } = req.auth;
  const ctx = { companyId, groupId, permissions, actorUserId: userId };
  const data = await req.withTenantTransaction((transaction) => readMetricResponse(ctx, req.params.code, req.query, { ip: req.ip, route: 'GET /analytics/metrics/:code' }, transaction));
  return success(res, { data });
});

function createMetricsRouter() {
  const router = Router();
  router.get('/:code', requireAnalyticsPermission(P.READ), getMetric);
  return router;
}

module.exports = { createMetricsRouter };
