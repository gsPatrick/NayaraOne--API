'use strict';

const crypto = require('node:crypto');
const { verifyAccessToken } = require('../../../../utils/jwt');
const { peekClientClaims } = require('../clients/token');

/**
 * Quem está chamando (M9-D843 §3.1): o limite é por CREDENCIAL. Usuário logado (JWT válido) = `u:<empresa>:<usuário>`; credencial de API externa (/api-external, client_id no cabeçalho
 * X-Client-Id ou chave no Authorization) = `x:<hash da credencial>`; sem credencial (login, /public/share) = `ip:<IP>`. Token inválido ou vencido conta como sem credencial.
 */
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const isExternal = (req) => /\/api-external(\/|$)/.test(req.originalUrl || req.url || '');

function identify(req) {
  const authorization = req.get('authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const clientId = req.get('x-client-id');
  const claims = isExternal(req) ? peekClientClaims(req) : null;
  if (claims) return { kind: 'external', scopeKey: `x:${hash(claims.client_id)}`, tenant: null }; // o limite é por client_id, não por token (M9-D844 regra 6)
  if (isExternal(req) && (clientId || bearer)) return { kind: 'external', scopeKey: `x:${hash(clientId || bearer)}`, tenant: null };
  if (bearer) {
    try {
      const payload = verifyAccessToken(bearer);
      if (payload.sub && payload.company_id) return { kind: 'internal', scopeKey: `u:${payload.company_id}:${payload.sub}`, tenant: { groupId: payload.group_id, companyId: payload.company_id } };
    } catch (_e) { /* token inválido: segue como anônimo */ }
  }
  return { kind: 'anonymous', scopeKey: `ip:${req.ip || 'sem-ip'}`, tenant: null };
}

module.exports = { identify, isExternal };
