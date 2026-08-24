'use strict';

/**
 * Resposta HTTP padronizada da API — mantém formato consistente entre todas
 * as features (routes → controller → service).
 */
function success(res, { statusCode = 200, data = null, meta = undefined, message = undefined } = {}) {
  const body = { success: true, data };
  if (meta !== undefined) body.meta = meta;
  if (message !== undefined) body.message = message;
  return res.status(statusCode).json(body);
}

function failure(res, { statusCode = 500, code = 'INTERNAL_ERROR', message = 'Erro interno.', details = undefined } = {}) {
  const body = { success: false, error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return res.status(statusCode).json(body);
}

module.exports = { success, failure };
