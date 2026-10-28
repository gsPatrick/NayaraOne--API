'use strict';

/**
 * M9-D700 (3.6) — chave de cache do BI por permissão e escopo. Um cache de resposta só é seguro se a chave inclui quem pede:
 * empresa, usuário, recorte de carteira e o conjunto de permissões do BI (e as de domínio) do usuário. TTL: `analytics.cache.ttl_segundos`.
 */
const crypto = require('crypto');

function permissionDigest(ctx) {
  const list = ctx.permissions instanceof Set ? [...ctx.permissions] : [...(ctx.permissions || [])];
  return crypto.createHash('sha256').update(list.sort().join('|')).digest('hex').slice(0, 16);
}

function buildCacheKey(ctx, resource, params = {}, rowScope = { mode: 'ALL', userIds: [] }) {
  const stable = JSON.stringify(params, Object.keys(params).sort());
  const scope = rowScope.mode === 'SELF' ? `self:${[...rowScope.userIds].sort().join(',')}` : 'all';
  return ['analytics', ctx.groupId, ctx.companyId, permissionDigest(ctx), scope, resource, crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16)].join(':');
}

module.exports = { buildCacheKey, permissionDigest };
