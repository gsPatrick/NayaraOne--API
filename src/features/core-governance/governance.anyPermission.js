'use strict';

const AppError = require('../../utils/AppError');
const { requirePermission } = require('../../middlewares/auth.middleware');

/**
 * Exige UMA das permissões da lista (ex.: leitura da política de DLP com `governance:dlp:export` ou `governance:dlp:admin`). Fail closed como
 * `requirePermission`: sem `req.auth` ou sem nenhuma das permissões, 403 PERMISSION_DENIED com `details.required` = a primeira da lista (a de menor risco).
 * `requiredPermission` marca a primeira para a matriz de permissões da API; `requiredPermissions` guarda a lista inteira.
 */
function requireAnyPermission(codes) {
  const middleware = function requireAnyPermissionMiddleware(req, res, next) {
    if (!req.auth) return requirePermission(codes[0])(req, res, next); // sem login: a mesma recusa fail closed da plataforma
    if (!codes.some((code) => req.auth.permissions.includes(code))) {
      return next(AppError.forbidden('Você não tem permissão para realizar esta ação. Peça o acesso a quem administra o seu perfil.', 'PERMISSION_DENIED', { required: codes[0], anyOf: codes }));
    }
    return next();
  };
  middleware.requiredPermission = codes[0];
  middleware.requiredPermissions = codes;
  return middleware;
}

module.exports = { requireAnyPermission };
