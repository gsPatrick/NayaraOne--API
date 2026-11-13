'use strict';

const { sequelize, UserMembership, RolePermission, Permission } = require('../../../../models');

// Contexto de empresa dentro da transação (SET LOCAL app.company_id, sujeito ao RLS) e checagem
// de `finance:read` do usuário numa empresa do grupo — usados pelas transferências entre empresas.

async function setCompanyContext(companyId, transaction) {
  await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId }, transaction });
}

async function withCompanyContext(companyId, restoreCompanyId, transaction, fn) {
  await setCompanyContext(companyId, transaction);
  try {
    return await fn();
  } finally {
    await setCompanyContext(restoreCompanyId, transaction);
  }
}

async function actorCanReadFinanceIn(companyId, actorUserId, transaction) {
  const memberships = await UserMembership.findAll({
    where: { userId: actorUserId, companyId, status: 'ACTIVE' },
    attributes: ['roleId'],
    transaction,
  });
  const roleIds = memberships.map((m) => m.roleId).filter(Boolean);
  if (roleIds.length === 0) return false;
  const permission = await Permission.findOne({ where: { code: 'finance:read' }, transaction });
  if (!permission) return false;
  const count = await RolePermission.count({ where: { roleId: roleIds, permissionId: permission.id }, transaction });
  return count > 0;
}

module.exports = {
  setCompanyContext,
  withCompanyContext,
  actorCanReadFinanceIn,
};
