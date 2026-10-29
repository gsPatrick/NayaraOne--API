'use strict';

/**
 * M9-D690 — GET /analytics/metrics/:code/drilldown?companyId&component&filter&filterHash&filterSignature&page&pageSize (component só em indicador composto). Registrada no router de
 * /analytics DEPOIS da guarda de método e da transação somente leitura (M9-D612). Exige analytics:read; analytics:drilldown e a
 * permissão do domínio são conferidas no serviço, que devolve o agregado permitido quando faltam (403 ANALYTICS_DRILLDOWN_FORBIDDEN).
 * `filter`, `filterHash` e `filterSignature` são os de um item de `sourceRefs` (M9-D611); o período e as dimensões já vão dentro do
 * filtro assinado, por isso não existem parâmetros soltos de período ou dimensão (DI-D690-2).
 */
const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { P } = require('../security/permissionCatalog');
const { requireAnalyticsPermission } = require('../security/permissionGuard');
const { openDrilldown } = require('./drilldown.service');

const ctxOf = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId, actorUserId: req.auth.userId, permissions: req.auth.permissions });

function registerDrilldownRoutes(router) {
  router.get('/analytics/metrics/:code/drilldown', requireAnalyticsPermission(P.READ), catchAsync(async (req, res) => {
    const { companyId, component, filter, filterHash, filterSignature, page, pageSize } = req.query;
    const data = await req.withTenantTransaction((tx) => openDrilldown(ctxOf(req), {
      metricCode: req.params.code, companyId, component, filter, filterHash, filterSignature, page, pageSize, ip: req.ip, route: 'GET /analytics/metrics/:code/drilldown',
    }, tx));
    return success(res, { data });
  }));
}

module.exports = { registerDrilldownRoutes };
