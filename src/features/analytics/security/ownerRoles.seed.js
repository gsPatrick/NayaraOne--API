'use strict';

/**
 * DI-BI2-10 — garante, na empresa, os papéis de owner dos indicadores do BI (catálogo em read-models/owner.roles.js), para que o owner padrão de todo indicador
 * aponte para um papel que existe. Cria só o que falta (nome igual, sem diferenciar maiúsculas) e concede ao papel criado as permissões do owner (ver e dar o aceite);
 * papel que já existia não é tocado. Usado pela concessão padrão (POST /governance/permissions/apply-default), para as empresas criadas depois da migration
 * 20261116230000, que faz o mesmo nas empresas existentes. Auditoria por papel criado.
 */
const { Op, fn, col, where } = require('sequelize');
const { Permission, Role, RolePermission } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { OWNER_ROLES, OWNER_ROLE_CODES, OWNER_ROLE_PERMISSIONS, ownerRoleDescription } = require('../read-models/owner.roles');

async function ensureOwnerRoles(tenant, actorUserId, transaction) {
  const existing = await Role.findAll({
    where: { companyId: tenant.companyId, [Op.and]: [where(fn('upper', col('name')), { [Op.in]: OWNER_ROLE_CODES.map((c) => c.toUpperCase()) })] },
    transaction,
  });
  const have = new Set(existing.map((r) => String(r.name).toUpperCase()));
  const permissions = await Permission.findAll({ where: { code: [...OWNER_ROLE_PERMISSIONS] }, transaction });
  const criados = [];
  for (const code of OWNER_ROLE_CODES.filter((c) => !have.has(c.toUpperCase()))) {
    const role = await Role.create({
      groupId: tenant.groupId, companyId: tenant.companyId, name: code, description: ownerRoleDescription(code), isSystem: false, createdBy: actorUserId || null, updatedBy: actorUserId || null,
    }, { transaction });
    for (const p of permissions) await RolePermission.create({ roleId: role.id, permissionId: p.id, createdBy: actorUserId || null, updatedBy: actorUserId || null }, { transaction });
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'analytics.owner_role.created', entityType: 'Role', entityId: role.id,
      afterJson: { name: code, permissions: permissions.map((p) => p.code).sort() }, reason: `Papel de owner dos indicadores do BI (${OWNER_ROLES[code]}) criado pela concessão padrão.`,
    }, transaction);
    criados.push(code);
  }
  return { papeis: OWNER_ROLE_CODES.length, criados };
}

module.exports = { ensureOwnerRoles };
