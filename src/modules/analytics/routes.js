'use strict';

const { Router } = require('express');
const { authMiddleware } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const { analyticsMethodGuard, analyticsReadOnlyTransaction } = require('./readOnly');

/**
 * Rotas do BI em /v1/analytics/*. Ordem em toda rota: autenticação -> tenant -> guarda de método (405) -> transação somente
 * leitura nos GET (M9-D612). Auth e tenant valem só sob /analytics (nunca router.use sem caminho). As demandas do BI registram
 * as rotas depois da guarda, neste router; `authChain` é injetável só para o teste de varredura.
 */
function createAnalyticsRouter({ authChain = [authMiddleware, tenantMiddleware] } = {}) {
  const router = Router();
  router.use('/analytics', ...authChain, analyticsMethodGuard, analyticsReadOnlyTransaction);
  return router;
}

module.exports = { createAnalyticsRouter, router: createAnalyticsRouter() };
