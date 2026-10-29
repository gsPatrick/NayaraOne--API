'use strict';

/**
 * M9-D692 (3.2) — destinatários do alerta. O owner da definição é um usuário (`owner_user_id`) ou um papel (`owner_role`): usuário ativo é ele;
 * papel vale para todos os usuários ativos do papel. Owner inativo/removido ou papel sem ninguém ativo: o alerta nunca fica sem destinatário,
 * o motor usa o papel reserva `analytics.alert.owner_reserva` (padrão do administrador: Diretoria) e devolve o motivo para o evento
 * `analytics.alert.owner_fallback`.
 */
const { isActiveUser, activeUsersOfRole } = require('./owner.members');

const REASONS = Object.freeze({ USER: 'OWNER_USER_INACTIVE', ROLE: 'OWNER_ROLE_EMPTY' });
const hasText = (v) => typeof v === 'string' && v.trim().length > 0;

/** { userIds, fallback, reason, fallbackRole }: `fallback` true quando o owner da definição não tinha ninguém ativo. */
async function resolveOwnerRecipients(def, scope, params, transaction) {
  let reason = null;
  if (def.owner_user_id) {
    if (await isActiveUser(def.owner_user_id, scope.companyId, transaction)) return { userIds: [def.owner_user_id], fallback: false, reason: null, fallbackRole: null };
    reason = REASONS.USER;
  }
  if (hasText(def.owner_role)) {
    const members = await activeUsersOfRole(def.owner_role, scope.companyId, transaction);
    if (members.length) return { userIds: members, fallback: false, reason: null, fallbackRole: null };
    reason = reason || REASONS.ROLE;
  }
  const fallbackRole = params.ownerFallback;
  return { userIds: await activeUsersOfRole(fallbackRole, scope.companyId, transaction), fallback: true, reason: reason || REASONS.ROLE, fallbackRole };
}

module.exports = { resolveOwnerRecipients, REASONS };
