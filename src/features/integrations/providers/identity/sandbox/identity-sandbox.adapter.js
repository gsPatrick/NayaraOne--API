'use strict';

const { IdentityAdapter } = require('../identity.port');
const { classifyHttpError } = require('../../../registry/classifyHttpError');
const { raiseFault, faultOf } = require('../../../registry/sandboxFaults');
const { verifyJwtStrict, peekHeader, createJwksCache } = require('../identity.jwt');
const { tokenInvalid } = require('../identity.errors');
const keys = require('./identity.sandbox.keys');

const STATUS = Object.freeze({ VALID: 'VALID', REVOKED: 'REVOKED', OK: 'OK' });
const caches = new Map();
const revoked = new Set();

/**
 * identity-sandbox (M9-D242): provedor de identidade OIDC simulado, sem rede. Publica o JWKS do par RSA de laboratório, valida token (assinatura pelo JWKS com cache,
 * `iss`/`aud`/`exp`/`nbf` obrigatórios, algoritmo em lista, relógio com tolerância) e falha por cabeçalho `x-sandbox-fail`. Emissor e público vêm da connection (`config.issuer`, `config.audience`).
 */
class IdentitySandboxAdapter extends IdentityAdapter {
  providerCode() { return 'identity-sandbox'; }

  capabilities() { return ['verifyToken', 'getUserInfo', 'revokeSession', 'listJwks']; }

  supportedVersions() { return ['v1']; }

  async healthCheck(ctx, opts) {
    try { return faultOf(ctx || this.ctx, opts || {}) ? { ok: false, latencyMs: 0, detail: 'Falha simulada pelo sandbox.' } : { ok: true, latencyMs: 0, detail: 'Sandbox local: não faz chamada externa.' }; } catch { return { ok: false, latencyMs: 0, detail: 'Falha ao testar o sandbox.' }; }
  }

  classifyError(e) { return classifyHttpError(e); }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(STATUS, s) ? STATUS[s] : null;
  }

  cacheOf(ctx, ttlS) {
    const id = ctx.connection.id || 'sem-connection';
    if (!caches.has(id)) caches.set(id, createJwksCache({ fetchJwks: async () => keys.jwks(), ttlMs: (Number(ttlS) > 0 ? Number(ttlS) : 300) * 1000 }));
    return caches.get(id);
  }

  /** Valida o token pelo JWKS. `meta`: algorithms, clockToleranceS, jwksCacheTtlS, now (da configuração da empresa, entregues pelo domínio). */
  async validate(ctx, request, meta = {}) {
    const header = peekHeader(request.token);
    const cfg = (ctx && ctx.connection && ctx.connection.config) || {};
    try {
      const key = header && header.kid ? await this.cacheOf(ctx, meta.jwksCacheTtlS).getKey(header.kid) : null;
      const claims = verifyJwtStrict(request.token, key, { algorithms: meta.algorithms || ['RS256'], issuer: cfg.issuer || 'identity-sandbox', audience: cfg.audience || 'nayara-one', clockToleranceS: meta.clockToleranceS, now: meta.now });
      if (revoked.has(`${ctx.connection.id}|${claims.sid || claims.sub}`)) throw Object.assign(new Error('revogada'), { code: 'SESSION_REVOKED' });
      return claims;
    } catch (err) {
      throw tokenInvalid(err.code);
    }
  }

  async verifyToken(ctx, request, meta) {
    await raiseFault(ctx, request, 'read');
    const claims = await this.validate(ctx, request, meta);
    return { externalRequestId: null, externalResourceId: String(claims.sub), status: 'VALID', subject: String(claims.sub), claims };
  }

  async getUserInfo(ctx, request, meta) {
    await raiseFault(ctx, request, 'read');
    const claims = await this.validate(ctx, request, meta);
    return { externalRequestId: null, externalResourceId: String(claims.sub), status: 'OK', subject: String(claims.sub), claims: { sub: claims.sub, email: claims.email || null, name: claims.name || null } };
  }

  async revokeSession(ctx, request) {
    await raiseFault(ctx, request, 'write');
    revoked.add(`${ctx.connection.id}|${request.sessionId}`);
    return { externalRequestId: null, externalResourceId: String(request.sessionId), status: 'REVOKED' };
  }

  async listJwks(ctx, request) {
    await raiseFault(ctx, request, 'read');
    return { externalRequestId: null, externalResourceId: null, status: 'OK', keys: keys.jwks().keys };
  }
}

module.exports = { IdentitySandboxAdapter, resetIdentitySandbox: () => { caches.clear(); revoked.clear(); keys.reset(); } };
