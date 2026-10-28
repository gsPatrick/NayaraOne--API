'use strict';

/**
 * M9-D603 — permissão do registro de métricas, checada no serviço (não há rota de cadastro no livro).
 * Escrita: analytics:manage. Leitura: analytics:read ou analytics:manage. Os códigos nascem em M9-D700.
 * `ctx.permissions` é a lista (Array ou Set) de permissões do usuário na requisição.
 */
const AppError = require('../../../utils/AppError');

const MANAGE = 'analytics:manage';
const READ = 'analytics:read';

function has(ctx, code) {
  const p = ctx && ctx.permissions;
  if (!p) return false;
  return p instanceof Set ? p.has(code) : Array.isArray(p) && p.includes(code);
}

function denied(code) {
  return AppError.forbidden(`Permissão ausente: ${code}.`, 'PERMISSION_DENIED', { permission: code });
}

function assertCanManage(ctx) {
  if (!has(ctx, MANAGE)) throw denied(MANAGE);
}

function assertCanRead(ctx) {
  if (!has(ctx, READ) && !has(ctx, MANAGE)) throw denied(READ);
}

module.exports = { MANAGE, READ, assertCanManage, assertCanRead };
