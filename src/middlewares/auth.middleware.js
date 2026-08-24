'use strict';

const AppError = require('../utils/AppError');
const { verifyAccessToken } = require('../utils/jwt');

/**
 * Middleware de autenticação — extrai e valida o JWT de acesso do header
 * `Authorization: Bearer <token>`, populando `req.auth` com as claims resolvidas
 * no login (ver src/features/auth/auth.service.js):
 *
 *   req.auth = { userId, groupId, companyId, roles: string[], permissions: string[] }
 *
 * Fail closed (IAM-015): ausência de header, token malformado, assinatura inválida ou
 * token expirado sempre resultam em 401 — nunca em prosseguir sem identidade resolvida.
 * Deve ser montado em toda rota que não seja pública (health/ping/auth/login/refresh).
 */
function authMiddleware(req, res, next) {
  const header = req.header('authorization') || req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return next(AppError.unauthorized('Token de acesso ausente.', 'MISSING_ACCESS_TOKEN'));
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return next(AppError.unauthorized('Token de acesso ausente.', 'MISSING_ACCESS_TOKEN'));
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    return next(err);
  }

  if (!payload.sub || !payload.group_id || !payload.company_id) {
    return next(
      AppError.unauthorized('Token de acesso não carrega contexto de tenant completo.', 'INVALID_ACCESS_TOKEN_CLAIMS')
    );
  }

  req.auth = {
    userId: payload.sub,
    groupId: payload.group_id,
    companyId: payload.company_id,
    roles: payload.roles || [],
    permissions: payload.permissions || [],
  };

  return next();
}

/**
 * Middleware factory de autorização por permissão granular (RBAC).
 * Uso: `router.post('/companies', authMiddleware, requirePermission('companies:create'), ...)`.
 * Fail closed: sem `req.auth` (auth.middleware não rodou antes) ou sem a permissão exata
 * na lista resolvida no login, a requisição é bloqueada com 403 — nunca com bypass silencioso.
 */
function requirePermission(permissionCode) {
  return function requirePermissionMiddleware(req, res, next) {
    if (!req.auth) {
      return next(AppError.unauthorized('Contexto de autenticação ausente.', 'AUTH_CONTEXT_MISSING'));
    }
    if (!req.auth.permissions.includes(permissionCode)) {
      return next(
        AppError.forbidden(
          `Permissão ausente: ${permissionCode}.`,
          'PERMISSION_DENIED',
          { required: permissionCode }
        )
      );
    }
    return next();
  };
}

module.exports = { authMiddleware, requirePermission };
