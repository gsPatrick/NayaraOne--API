'use strict';

const { auditBlocked } = require('./bulk.audit');
const { parseIdempotencyKey } = require('./bulk.input');
const { PERMISSION } = require('./bulk.constants');

/**
 * Antes da checagem de permissão (M9-D808 §3.1 passo 1): quem não tem `governance:data-quality:bulk` é barrado com 403 pelo requirePermission da rota e,
 * aqui, a tentativa fica auditada (autor, rota e permissão que faltou). Nada é gravado além da auditoria.
 */
async function auditDeniedBulk(req, res, next) {
  if (!req.auth || (req.auth.permissions || []).includes(PERMISSION)) return next();
  try {
    await auditBlocked({ groupId: req.auth.groupId, companyId: req.auth.companyId }, req.auth.userId, { code: 'PERMISSION_DENIED', required: PERMISSION, method: req.method, path: req.originalUrl.split('?')[0] });
  } catch (_err) { /* a recusa 403 sai de qualquer jeito; a falha de auditoria já vai ao log do Sequelize */ }
  return next();
}

/** O cabeçalho Idempotency-Key é EXIGIDO nesta rota (M9-D843 §3.3): 400 GOV_IDEMPOTENCY_KEY_REQUIRED sem ele. Vem antes do MFA. */
function requireIdempotencyKey(req, res, next) {
  try { parseIdempotencyKey(req.get('Idempotency-Key')); return next(); } catch (err) { return next(err); }
}

module.exports = { auditDeniedBulk, requireIdempotencyKey };
