'use strict';

/**
 * M9-D700 — guarda de permissão do BI, usada por serviço, rota, exportação e ferramentas da NAY (um só caminho).
 * `ctx.permissions` é Array ou Set. Falta de permissão: 403 PERMISSION_DENIED com o código ausente (regra única de status).
 */
const { nextWithDeferredFileAttach } = require('../../../middlewares/deferredFileAttach');
const AppError = require('../../../utils/AppError');

function has(ctx, code) {
  const p = ctx && ctx.permissions;
  if (!p) return false;
  return p instanceof Set ? p.has(code) : Array.isArray(p) && p.includes(code);
}

function denied(code) {
  return AppError.forbidden(`Permissão ausente: ${code}.`, 'PERMISSION_DENIED', { permission: code, required: code });
}

function assertPermission(ctx, code) {
  if (!has(ctx, code)) throw denied(code);
}

/**
 * Middleware de rota do BI: igual a requirePermission, com a mensagem do livro ("Permissão ausente: <código>."). Marca
 * `requiredPermission` para a matriz de permissões da API (scripts/gerarMatrizPermissoes.js) e para a varredura de rotas.
 */
function requireAnalyticsPermission(code) {
  const middleware = function requireAnalyticsPermissionMiddleware(req, res, next) {
    if (!req.auth) return next(AppError.unauthorized('Contexto de autenticação ausente.', 'AUTH_CONTEXT_MISSING'));
    if (!has({ permissions: req.auth.permissions }, code)) return next(denied(code));
    return nextWithDeferredFileAttach(req, next);
  };
  middleware.requiredPermission = code;
  return middleware;
}

module.exports = { has, denied, assertPermission, requireAnalyticsPermission };
