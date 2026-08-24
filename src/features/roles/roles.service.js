'use strict';

const { Role, Permission, RolePermission, UserMembership } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

// "core"."roles" tem RLS (company_id = current_setting('app.company_id')), então toda query
// aqui recebe `transaction` já aberta por `req.withTenantTransaction`.

const ROLE_INCLUDE = [
  {
    model: RolePermission,
    as: 'rolePermissions',
    required: false,
    include: [{ model: Permission, as: 'permission', required: false }],
  },
];

function serializeRole(role) {
  const json = role.toJSON();
  return {
    ...json,
    permissions: (json.rolePermissions || [])
      .map((rp) => rp.permission)
      .filter(Boolean)
      .map((p) => ({ id: p.id, code: p.code, description: p.description, riskLevel: p.riskLevel })),
    rolePermissions: undefined,
  };
}

async function assertPermissionsExist(permissionIds, transaction) {
  if (!permissionIds || permissionIds.length === 0) return [];
  const unique = [...new Set(permissionIds)];
  const found = await Permission.findAll({ where: { id: unique }, transaction });
  if (found.length !== unique.length) {
    throw AppError.badRequest('Uma ou mais permissões informadas não existem no catálogo.', 'ROLE_PERMISSION_NOT_FOUND');
  }
  return unique;
}

/**
 * createRole — cria um papel (role) e já atribui o conjunto de permissões marcado na tela de
 * administração (permissionIds). Papel é escopado por empresa (groupId/companyId).
 */
async function createRole(payload, actorUserId, transaction) {
  const { groupId, companyId, name, description, permissionIds } = payload;
  if (!groupId || !companyId || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "name" são obrigatórios.', 'ROLE_VALIDATION');
  }

  const uniquePermissionIds = await assertPermissionsExist(permissionIds, transaction);

  const role = await Role.create(
    {
      groupId,
      companyId,
      name,
      description: description || null,
      isSystem: false,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  if (uniquePermissionIds.length > 0) {
    await RolePermission.bulkCreate(
      uniquePermissionIds.map((permissionId) => ({
        roleId: role.id,
        permissionId,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      })),
      { transaction }
    );
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'roles.create',
      entityType: 'Role',
      entityId: role.id,
      afterJson: { name: role.name, permissionIds: uniquePermissionIds },
      reason: `Papel "${role.name}" criado com ${uniquePermissionIds.length} permissão(ões).`,
    },
    transaction
  );

  const created = await Role.findByPk(role.id, { include: ROLE_INCLUDE, transaction });
  return serializeRole(created);
}

async function listRoles(transaction, filters = {}) {
  const where = {};
  if (filters.companyId) where.companyId = filters.companyId;
  const roles = await Role.findAll({ where, include: ROLE_INCLUDE, order: [['name', 'ASC']], transaction });
  return roles.map(serializeRole);
}

async function getRoleModel(id, transaction) {
  const role = await Role.findByPk(id, { include: ROLE_INCLUDE, transaction });
  if (!role) throw AppError.notFound('Papel não encontrado.', 'ROLE_NOT_FOUND');
  return role;
}

async function getRole(id, transaction) {
  return serializeRole(await getRoleModel(id, transaction));
}

/**
 * updateRole — edita nome/descrição e, quando `permissionIds` é enviado, SUBSTITUI o conjunto
 * inteiro de permissões do papel pelo novo conjunto marcado na tela (mais simples e previsível
 * para uma UI de checkboxes do que calcular diff de add/remove).
 */
async function updateRole(id, payload, actorUserId, transaction) {
  const role = await getRoleModel(id, transaction);
  if (role.isSystem) {
    throw AppError.conflict('Papéis de sistema não podem ser editados.', 'ROLE_IS_SYSTEM');
  }
  const beforeJson = serializeRole(role);

  const { name, description, permissionIds } = payload;
  if (name !== undefined) role.name = name;
  if (description !== undefined) role.description = description;
  role.updatedBy = actorUserId || null;
  await role.save({ transaction });

  if (permissionIds !== undefined) {
    const uniquePermissionIds = await assertPermissionsExist(permissionIds, transaction);
    await RolePermission.destroy({ where: { roleId: role.id }, transaction });
    if (uniquePermissionIds.length > 0) {
      await RolePermission.bulkCreate(
        uniquePermissionIds.map((permissionId) => ({
          roleId: role.id,
          permissionId,
          createdBy: actorUserId || null,
          updatedBy: actorUserId || null,
        })),
        { transaction }
      );
    }
  }

  const updated = await getRoleModel(role.id, transaction);

  await registrarAuditoria(
    {
      groupId: role.groupId,
      companyId: role.companyId,
      actorUserId,
      action: 'roles.update',
      entityType: 'Role',
      entityId: role.id,
      beforeJson,
      afterJson: serializeRole(updated),
      reason: `Papel "${role.name}" atualizado.`,
    },
    transaction
  );

  return serializeRole(updated);
}

/**
 * removeRole — bloqueia exclusão de papel de sistema e de papel em uso (com vínculo ativo),
 * para nunca deixar um usuário logado com um roleId órfão.
 */
async function removeRole(id, actorUserId, transaction) {
  const role = await getRoleModel(id, transaction);
  if (role.isSystem) {
    throw AppError.conflict('Papéis de sistema não podem ser excluídos.', 'ROLE_IS_SYSTEM');
  }
  const activeMemberships = await UserMembership.count({
    where: { roleId: role.id, status: 'ACTIVE' },
    transaction,
  });
  if (activeMemberships > 0) {
    throw AppError.conflict(
      `Este papel está em uso por ${activeMemberships} usuário(s) ativo(s) — revogue ou reatribua o vínculo antes de excluir.`,
      'ROLE_IN_USE'
    );
  }

  const beforeJson = serializeRole(role);
  role.deletedBy = actorUserId || null;
  await role.save({ transaction });
  await role.destroy({ transaction });

  await registrarAuditoria(
    {
      groupId: role.groupId,
      companyId: role.companyId,
      actorUserId,
      action: 'roles.delete',
      entityType: 'Role',
      entityId: role.id,
      beforeJson,
      reason: `Papel "${role.name}" excluído.`,
    },
    transaction
  );

  return { id: role.id };
}

async function listPermissionsCatalog(transaction) {
  const permissions = await Permission.findAll({ order: [['code', 'ASC']], transaction });
  return permissions.map((p) => ({ id: p.id, code: p.code, description: p.description, riskLevel: p.riskLevel }));
}

module.exports = {
  createRole,
  listRoles,
  getRole,
  updateRole,
  removeRole,
  listPermissionsCatalog,
};
