'use strict';

const { Op } = require('sequelize');
const { Permission, RolePermission, UserMembership } = require('../../../models');

/**
 * Pessoas ATIVAS da empresa do contexto cujo papel concede a permissão `code` (ordem estável por id). Usado pelo grounding para
 * dirigir a confirmação humana de prazo/contrato crítico a quem tem legal:read (M9-D025). Lê sob o RLS da transação do tenant.
 */
async function listUsersWithPermission(ctx, code, transaction) {
  const permission = await Permission.findOne({ where: { code }, transaction });
  if (!permission) return [];
  const grants = await RolePermission.findAll({ where: { permissionId: permission.id }, attributes: ['roleId'], transaction });
  const roleIds = [...new Set(grants.map((g) => g.roleId))];
  if (!roleIds.length) return [];
  const memberships = await UserMembership.findAll({
    where: { companyId: ctx.companyId, status: 'ACTIVE', roleId: { [Op.in]: roleIds } }, attributes: ['userId'], transaction,
  });
  return [...new Set(memberships.map((m) => m.userId))].sort();
}

module.exports = { listUsersWithPermission };
