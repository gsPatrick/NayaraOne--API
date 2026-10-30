'use strict';

const { IdentityAdapter } = require('./identity.port');
const { classifyHttpError } = require('../../registry/classifyHttpError');
const { verifyLocalToken, sessionIsActive } = require('./identity.local');
const { tokenInvalid } = require('./identity.errors');

const STATUS = Object.freeze({ VALID: 'VALID', REVOKED: 'REVOKED', OK: 'OK' });

/**
 * identity-local (M9-D242 3.2): o adapter padrão da identidade. Envolve a autenticação que o sistema já tem (JWT do app com sessão em core.sessions; o MFA segue sendo regra
 * do Nayara) atrás do port. Não faz chamada externa. O que precisa de banco (sessão, usuário) usa a transação que o domínio entrega em `meta.transaction`.
 */
class IdentityLocalAdapter extends IdentityAdapter {
  providerCode() { return 'identity-local'; }

  capabilities() { return ['verifyToken', 'getUserInfo', 'revokeSession', 'listJwks']; }

  supportedVersions() { return ['v1']; }

  async healthCheck() { return { ok: true, latencyMs: 0, detail: 'Autenticação própria do sistema: não depende de rede.' }; }

  classifyError(e) { return classifyHttpError(e); }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(STATUS, s) ? STATUS[s] : null;
  }

  /** Tolerância de relógio da configuração (meta.clockToleranceS, entregue por quem chama). */
  async verify(request, meta) {
    const claims = verifyLocalToken(request.token, { clockToleranceS: meta && meta.clockToleranceS });
    if (!(await sessionIsActive(claims, meta && meta.transaction))) throw tokenInvalid('SESSION_REVOKED');
    return claims;
  }

  async verifyToken(_ctx, request, meta) {
    const claims = await this.verify(request, meta);
    return { externalRequestId: null, externalResourceId: String(claims.sub), status: 'VALID', subject: String(claims.sub), claims };
  }

  async getUserInfo(_ctx, request, meta) {
    const claims = await this.verify(request, meta);
    let info = {};
    if (meta && meta.transaction) {
      const { User } = require('../../../../models');
      const u = await User.findByPk(claims.sub, { attributes: ['id', 'name', 'email'], transaction: meta.transaction });
      if (u) info = { name: u.name, email: u.email };
    }
    return { externalRequestId: null, externalResourceId: String(claims.sub), status: 'OK', subject: String(claims.sub), claims: { ...info, roles: claims.roles || [], companyId: claims.company_id } };
  }

  /** Idempotente: sessão já revogada ou inexistente não é erro. */
  async revokeSession(_ctx, request, meta) {
    const { Session } = require('../../../../models');
    const transaction = meta && meta.transaction;
    const sessao = await Session.findByPk(request.sessionId, { transaction });
    if (sessao && !sessao.revokedAt) await sessao.update({ revokedAt: new Date() }, { transaction });
    return { externalRequestId: null, externalResourceId: String(request.sessionId), status: 'REVOKED' };
  }

  /** Chave simétrica: não há chave pública para publicar. */
  async listJwks() { return { externalRequestId: null, externalResourceId: null, status: 'OK', keys: [] }; }
}

module.exports = { IdentityLocalAdapter };
