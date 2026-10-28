'use strict';

const logger = require('../../../utils/logger');
const { readOnlyMethodError } = require('./readOnly.errors');

const WRITE_METHODS = new Set(['PUT', 'PATCH', 'DELETE']);
// Montado em router.use('/analytics', ...): req.path chega sem o prefixo (ex.: "/metrics/fin.free_cash").
const PROTECTED_PATH = /^\/(metrics|dashboards)(\/|$)/;

/** M9-D612 (3.2) — PUT, PATCH e DELETE em /analytics/metrics/* e /analytics/dashboards/* respondem 405 ANALYTICS_READ_ONLY. */
function analyticsMethodGuard(req, res, next) {
  if (WRITE_METHODS.has(req.method) && PROTECTED_PATH.test(req.path)) {
    logger.warn({
      event: 'analytics.read_only_method', correlationId: req.correlationId, method: req.method, path: req.originalUrl,
      companyId: req.auth?.companyId, userId: req.auth?.userId,
    }, '[analytics] método de escrita recusado em rota de leitura');
    res.setHeader('Allow', 'GET, HEAD');
    return next(readOnlyMethodError());
  }
  return next();
}
analyticsMethodGuard.isAnalyticsReadOnlyGuard = true;

module.exports = { analyticsMethodGuard };
