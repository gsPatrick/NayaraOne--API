'use strict';

const { UserMembership, Role, RolePermission, Permission } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * Resolve os papéis (roles) e permissões (permission codes) efetivos de um usuário dentro
 * de um group/company específico, a partir de "core"."user_memberships" ->
 * "core"."roles" -> "core"."role_permissions" -> "core"."permissions".
 *
 * Usado tanto pelo login (para embutir claims no JWT) quanto pelo endpoint de consulta
 * de permissões efetivas (`GET /v1/memberships/:userId/effective-permissions`).
 *
 * `transaction` é opcional — quando chamado fora de uma transação com contexto de tenant
 * (ex. no bootstrap de login, antes de existir sessão), a query roda sem SET LOCAL; como
 * "user_memberships"/"roles"/"role_permissions" têm RLS FORCE, isso exige um papel de banco
 * com privilégio para o bootstrap (ver nota de pendência em Auth.md).
 */
async function getEffectiveAccess(userId, companyId, transaction) {
  const memberships = await UserMembership.findAll({
    where: { userId, companyId, status: 'ACTIVE' },
    include: [{ model: Role, as: 'role', required: false }],
    transaction,
  });

  const roleIds = [...new Set(memberships.map((m) => m.roleId).filter(Boolean))];

  let permissions = [];
  if (roleIds.length > 0) {
    const rolePermissions = await RolePermission.findAll({
      where: { roleId: roleIds },
      include: [{ model: Permission, as: 'permission', required: true }],
      transaction,
    });
    permissions = [...new Set(rolePermissions.map((rp) => rp.permission.code))];
  }

  const roles = memberships
    .filter((m) => m.role)
    .map((m) => ({ id: m.role.id, name: m.role.name }));

  return {
    memberships,
    roles,
    permissions,
    unitIds: [...new Set(memberships.map((m) => m.unitId).filter(Boolean))],
  };
}

async function listEffectivePermissions({ userId, companyId }) {
  if (!userId || !companyId) {
    throw AppError.badRequest('userId e companyId são obrigatórios.', 'MEMBERSHIP_CONTEXT_REQUIRED');
  }
  const access = await getEffectiveAccess(userId, companyId);
  return {
    userId,
    companyId,
    roles: access.roles,
    permissions: access.permissions,
    unitIds: access.unitIds,
  };
}

module.exports = { getEffectiveAccess, listEffectivePermissions };
