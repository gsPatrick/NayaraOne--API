'use strict';

const { verifyJwtStrict } = require('../../../../shared/identity/jwtStrict');
const { localIssuer, localAudience } = require('../../../../shared/identity/localClaims');
const { tokenInvalid } = require('./identity.errors');

/**
 * Núcleo do `identity-local` (M9-D242 3.2): a validação do token de acesso do próprio sistema. Assinatura HS256 com `JWT_ACCESS_SECRET` (o mesmo segredo de
 * `utils/jwt.js`), `iss`, `aud`, `exp` e `nbf` obrigatórios e tolerância de relógio dada pela configuração. Se o token cita uma sessão (`session_id`) e quem chama
 * entrega a transação da empresa, a sessão precisa estar ativa (não revogada nem vencida), como no authMiddleware.
 */
const LOCAL_ALGORITHMS = Object.freeze(['HS256']);

function localSecret() {
  const s = process.env.JWT_ACCESS_SECRET;
  if (!s) throw Object.assign(new Error('JWT_ACCESS_SECRET ausente.'), { code: 'JWT_CONFIG_MISSING', status: 500 });
  return s;
}

/** Claims do token local ou 401 INTEGRATION_IDENTITY_TOKEN_INVALID. */
function verifyLocalToken(token, { clockToleranceS = 0, now } = {}) {
  try {
    return verifyJwtStrict(token, localSecret(), { algorithms: LOCAL_ALGORITHMS, issuer: localIssuer(), audience: localAudience(), clockToleranceS, now });
  } catch (err) {
    if (err.code === 'JWT_CONFIG_MISSING') throw err;
    throw tokenInvalid(err.code);
  }
}

/** A sessão do token está ativa? Sem session_id ou sem transação: não há o que conferir (true). */
async function sessionIsActive(claims, transaction, now = new Date()) {
  if (!claims.session_id || !transaction) return true;
  const { Session } = require('../../../../models');
  const sessao = await Session.findByPk(claims.session_id, { transaction });
  return Boolean(sessao) && !sessao.revokedAt && sessao.expiresAt >= now;
}

/** Revoga a sessão (idempotente: já revogada ou inexistente não é erro). */
async function revokeLocalSession(sessionId, transaction) {
  const { Session } = require('../../../../models');
  const sessao = await Session.findByPk(sessionId, { transaction });
  if (sessao && !sessao.revokedAt) await sessao.update({ revokedAt: new Date() }, { transaction });
  return { revoked: true };
}

/** Tabela de sessões do sistema (`core.sessions`) como o adapter a enxerga; a suíte de contrato troca por um duplo em memória, sem banco. */
const localSessionStore = Object.freeze({ isActive: sessionIsActive, revoke: revokeLocalSession });

module.exports = { verifyLocalToken, sessionIsActive, revokeLocalSession, localSessionStore, LOCAL_ALGORITHMS };
