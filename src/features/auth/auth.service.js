'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { sequelize, User, Session, UserMembership } = require('../../models');
const AppError = require('../../utils/AppError');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../../utils/jwt');
const { getEffectiveAccess } = require('../memberships/effectivePermissions.service');

const BCRYPT_ROUNDS = 12;

function refreshTokenTtlMs() {
  // Espelha JWT_REFRESH_TTL apenas para calcular expires_at de core.sessions;
  // a validade "de fato" do token continua sendo controlada pelo próprio JWT.
  const ttl = process.env.JWT_REFRESH_TTL || '7d';
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unitMs = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[match[2]];
  return value * unitMs;
}

function hashRefreshToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Resolve o tenant ativo (group_id/company_id) a ser usado no login quando o cliente
 * não informa explicitamente `companyId`: usa o primeiro vínculo ACTIVE do usuário.
 * Fail closed: usuário sem nenhum vínculo ativo não consegue autenticar.
 *
 * Correção de segurança (achado ao provar RLS real sem superuser/BYPASSRLS): esta consulta
 * roda ANTES de existir group_id/company_id resolvido (é o próprio bootstrap do tenant), então
 * não pode depender da policy `tenant_isolation` de "core"."user_memberships" (baseada em
 * app.company_id — sempre NULL aqui). Por isso `transaction` é obrigatório aqui e o chamador
 * (login) já fez `SET LOCAL app.user_id` antes de chamar esta função — a policy
 * `self_membership_lookup` (SELECT apenas, `user_id = current_setting('app.user_id')`)
 * permite ao usuário autenticado enxergar somente os PRÓPRIOS vínculos, nunca os de terceiros.
 */
async function resolveActiveTenant(userId, requestedCompanyId, transaction) {
  const where = { userId, status: 'ACTIVE' };
  if (requestedCompanyId) where.companyId = requestedCompanyId;

  const membership = await UserMembership.findOne({ where, order: [['created_at', 'ASC']], transaction });
  if (!membership) {
    throw AppError.forbidden(
      requestedCompanyId
        ? 'Usuário não possui vínculo ativo com a empresa informada.'
        : 'Usuário não possui nenhum vínculo ativo (group/company). Login bloqueado (fail closed).',
      'NO_ACTIVE_MEMBERSHIP'
    );
  }
  return membership;
}

async function issueTokensForSession({ user, groupId, companyId, transaction, userAgent, ipAddress }) {
  const access = await getEffectiveAccess(user.id, companyId, transaction);

  const claims = {
    sub: user.id,
    group_id: groupId,
    company_id: companyId,
    roles: access.roles.map((r) => r.name),
    permissions: access.permissions,
  };

  const accessToken = signAccessToken(claims);
  const rawRefreshToken = crypto.randomUUID() + '.' + crypto.randomBytes(32).toString('hex');
  const refreshToken = signRefreshToken({ sub: user.id, group_id: groupId, company_id: companyId, jti: rawRefreshToken });

  const session = await Session.create(
    {
      userId: user.id,
      groupId,
      companyId,
      refreshTokenHash: hashRefreshToken(rawRefreshToken),
      userAgent: userAgent || null,
      ipAddress: ipAddress || null,
      expiresAt: new Date(Date.now() + refreshTokenTtlMs()),
      createdBy: user.id,
      updatedBy: user.id,
    },
    { transaction }
  );

  return { accessToken, refreshToken, session, claims };
}

/**
 * POST /v1/auth/login
 */
async function login({ email, password, companyId }, meta = {}) {
  if (!email || !password) {
    throw AppError.badRequest('E-mail e senha são obrigatórios.', 'AUTH_VALIDATION');
  }

  const user = await User.findOne({ where: { email: email.toLowerCase().trim() } });

  // Mensagem genérica propositalmente — não revela se o e-mail existe (evita user enumeration).
  const invalidCredentials = () =>
    AppError.unauthorized('Credenciais inválidas.', 'INVALID_CREDENTIALS');

  if (!user || user.status !== 'ACTIVE') {
    throw invalidCredentials();
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    throw invalidCredentials();
  }

  return sequelize.transaction(async (transaction) => {
    // Contexto de tenant progressivo dentro da MESMA transação (ver comentário de
    // resolveActiveTenant acima): primeiro só app.user_id (suficiente para a policy
    // self_membership_lookup encontrar o próprio vínculo), depois app.group_id/app.company_id
    // assim que resolvidos, para que o restante do login (roles/permissions/sessão) já rode
    // sob a policy tenant_isolation normal.
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: user.id }, transaction });

    const membership = await resolveActiveTenant(user.id, companyId, transaction);

    await sequelize.query('SET LOCAL app.group_id = :groupId', {
      replacements: { groupId: membership.groupId },
      transaction,
    });
    await sequelize.query('SET LOCAL app.company_id = :companyId', {
      replacements: { companyId: membership.companyId },
      transaction,
    });

    const { accessToken, refreshToken, session, claims } = await issueTokensForSession({
      user,
      groupId: membership.groupId,
      companyId: membership.companyId,
      transaction,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
    });

    user.lastLoginAt = new Date();
    user.updatedBy = user.id;
    await user.save({ transaction });

    return {
      accessToken,
      refreshToken,
      sessionId: session.id,
      user: { id: user.id, name: user.name, email: user.email },
      groupId: claims.group_id,
      companyId: claims.company_id,
      roles: claims.roles,
      permissions: claims.permissions,
    };
  });
}

/**
 * POST /v1/auth/refresh
 * Troca um refresh token válido e não revogado por um novo access token (rotaciona também
 * o refresh token — reuse detection: o token antigo é revogado nesta operação).
 */
async function refresh({ refreshToken: rawToken }, meta = {}) {
  if (!rawToken) {
    throw AppError.badRequest('refreshToken é obrigatório.', 'AUTH_VALIDATION');
  }

  const decoded = verifyRefreshToken(rawToken);
  const tokenHash = hashRefreshToken(decoded.jti);

  const session = await Session.findOne({ where: { refreshTokenHash: tokenHash } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw AppError.unauthorized('Sessão inválida, expirada ou revogada.', 'SESSION_INVALID');
  }

  const user = await User.findByPk(session.userId);
  if (!user || user.status !== 'ACTIVE') {
    throw AppError.unauthorized('Usuário inválido ou inativo.', 'SESSION_USER_INVALID');
  }

  return sequelize.transaction(async (transaction) => {
    // Rotação: revoga a sessão usada e emite uma nova (mitigação de refresh token reuse — IAM-TS).
    session.revokedAt = new Date();
    session.updatedBy = user.id;
    await session.save({ transaction });

    const { accessToken, refreshToken: newRefreshToken, session: newSession, claims } = await issueTokensForSession({
      user,
      groupId: session.groupId,
      companyId: session.companyId,
      transaction,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
      sessionId: newSession.id,
      groupId: claims.group_id,
      companyId: claims.company_id,
      roles: claims.roles,
      permissions: claims.permissions,
    };
  });
}

/**
 * POST /v1/auth/logout
 * Revoga a sessão associada ao refresh token informado (idempotente — refresh já revogado
 * ou inexistente não é erro, apenas confirma o estado final).
 */
async function logout({ refreshToken: rawToken }) {
  if (!rawToken) {
    throw AppError.badRequest('refreshToken é obrigatório.', 'AUTH_VALIDATION');
  }

  let decoded;
  try {
    decoded = verifyRefreshToken(rawToken);
  } catch (err) {
    // Token já inválido/expirado: logout é idempotente, não há sessão para revogar.
    return { revoked: false };
  }

  const tokenHash = hashRefreshToken(decoded.jti);
  const session = await Session.findOne({ where: { refreshTokenHash: tokenHash } });
  if (!session || session.revokedAt) {
    return { revoked: false };
  }

  session.revokedAt = new Date();
  await session.save();
  return { revoked: true };
}

module.exports = { login, refresh, logout };
