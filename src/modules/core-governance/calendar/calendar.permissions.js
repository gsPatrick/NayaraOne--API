'use strict';

const ADMIN_ROLE = 'ADMIN';

/** Compromisso avulso: só a pessoa responsável ou um administrador (papel ADMIN) o altera. */
function canManageCommitment(actor, commitment) {
  if (!actor) return false;
  if ((actor.roles || []).some((role) => String(role).toUpperCase() === ADMIN_ROLE)) return true;
  return Boolean(actor.userId) && actor.userId === commitment.ownerUserId;
}

module.exports = { canManageCommitment, ADMIN_ROLE };
