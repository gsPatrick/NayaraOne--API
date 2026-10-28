'use strict';

const { Router } = require('express');
const catchAsync = require('../../utils/catchAsync');
const logger = require('../../utils/logger');
const { mktForbidden } = require('./marketing.errors');

function tenantFromAuth(req) {
  return { groupId: req.auth.groupId, companyId: req.auth.companyId };
}

/**
 * Porta de permissão do Marketing: sem a permissão exata no token, 403 MKT_FORBIDDEN (nunca vaza stack nem quem tem o acesso).
 * Fail closed: sem req.auth a requisição não passa. A permissão exigida segue em details.required, para o suporte.
 */
function requireMarketingPermission(permissionCode) {
  const middleware = function requireMarketingPermissionMiddleware(req, res, next) {
    if (!req.auth || !Array.isArray(req.auth.permissions) || !req.auth.permissions.includes(permissionCode)) {
      return next(mktForbidden({ required: permissionCode }));
    }
    return next();
  };
  // Marca a permissão exigida para a matriz de permissões gerada do código (scripts/gerarMatrizPermissoes.js).
  middleware.requiredPermission = permissionCode;
  return middleware;
}

/** Registra o correlation_id (X-Correlation-Id do cliente ou gerado pela API) em todo handler do Marketing. */
function withCorrelationLog(handler) {
  return async function marketingHandler(req, res, next) {
    logger.info({
      correlationId: req.correlationId || null,
      method: req.method,
      route: req.route ? req.route.path : req.path,
      userId: req.auth ? req.auth.userId : null,
      companyId: req.auth ? req.auth.companyId : null,
    }, 'marketing.request');
    return handler(req, res, next);
  };
}

/**
 * Monta o router de uma área do Marketing. Autenticação e tenant são aplicados UMA vez, sob o prefixo `/marketing`, no index.js do
 * módulo (router.use sem caminho interceptaria qualquer requisição de /v1). Cada rota: permissão -> (portas extras) -> handler
 * com correlation_id no log.
 */
function buildMarketingRouter(routeDefs) {
  const router = Router();
  for (const def of routeDefs) {
    const gates = (def.gates || []).map((gate) => catchAsync(gate));
    router[def.method](def.path, requireMarketingPermission(def.permission), ...gates, catchAsync(withCorrelationLog(def.handler)));
  }
  return router;
}

module.exports = { tenantFromAuth, requireMarketingPermission, withCorrelationLog, buildMarketingRouter };
