'use strict';

const AppError = require('../../utils/AppError');

/** Aceita quem tem QUALQUER uma das permissões (a matriz de permissões lê `requiredPermission`). */
function anyOf(...codes) {
  const middleware = (req, res, next) => {
    if (!req.auth) return next(AppError.unauthorized('Contexto de autenticação ausente.', 'AUTH_CONTEXT_MISSING'));
    if (!codes.some((code) => req.auth.permissions.includes(code))) {
      return next(AppError.forbidden('Você não tem permissão para realizar esta ação. Peça o acesso a quem administra o seu perfil.', 'PERMISSION_DENIED', { required: codes.join('|'), alternatives: codes }));
    }
    return next();
  };
  middleware.requiredPermission = codes.join('|');
  return middleware;
}

module.exports = { anyOf };
