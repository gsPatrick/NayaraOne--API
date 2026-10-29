'use strict';

const errors = require('./data-quality.errors');

const ROLES = Object.freeze(['OWNER', 'STEWARD']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Corpo do PUT: { designations: [{ role: 'OWNER'|'STEWARD', userId }] }. Duas linhas OWNER = 409 (um único owner por domínio). */
function parseDesignations(body) {
  const list = body && body.designations;
  if (!Array.isArray(list) || list.length === 0) {
    throw errors.validation('Informe a lista "designations" com pelo menos uma designação.', { field: 'designations' });
  }
  const parsed = list.map((entry, index) => {
    const role = entry && typeof entry.role === 'string' ? entry.role.trim().toUpperCase() : '';
    if (!ROLES.includes(role)) throw errors.validation(`O papel da designação ${index + 1} deve ser OWNER ou STEWARD.`, { field: `designations[${index}].role` });
    if (!entry || typeof entry.userId !== 'string' || !UUID.test(entry.userId)) {
      throw errors.validation(`O usuário da designação ${index + 1} é inválido.`, { field: `designations[${index}].userId` });
    }
    return { role, userId: entry.userId.toLowerCase() };
  });
  if (parsed.filter((item) => item.role === 'OWNER').length > 1) throw errors.ownerConflict();
  const seen = new Set();
  return parsed.filter((item) => {
    const key = `${item.role}:${item.userId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { ROLES, parseDesignations };
