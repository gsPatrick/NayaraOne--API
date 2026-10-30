'use strict';

const { rows, one, blocker } = require('./sql');

/** Impacto de desativar um usuário (linha 6): vínculos com empresas e sessões abertas que serão encerradas. */
async function user({ id, transaction }) {
  const u = await one(transaction, 'SELECT id, name, email, status FROM core.users WHERE id = :id AND deleted_at IS NULL', { id }, 'Usuário não encontrado.', 'USER_NOT_FOUND');
  const [memberships] = await rows(transaction, `SELECT COUNT(*)::int AS n FROM core.user_memberships WHERE user_id = :id AND deleted_at IS NULL AND status = 'ACTIVE'`, { id });
  const [sessions] = await rows(transaction, 'SELECT COUNT(*)::int AS n FROM core.sessions WHERE user_id = :id AND revoked_at IS NULL AND expires_at > now()', { id });
  const blockers = u.status !== 'ACTIVE' ? [blocker('USER_NOT_ACTIVE', 'o usuário já está desativado')] : [];
  return {
    code: u.email,
    label: u.name,
    impact: { counts: { users: 1, activeMemberships: memberships.n, openSessions: sessions.n }, totalAmountCents: 0, blockers, items: [{ type: 'USER', id: u.id, label: `${u.name} (${u.email})` }] },
  };
}

module.exports = { user };
