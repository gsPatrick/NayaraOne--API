'use strict';

const { UserMembership, Role, Unit, Company } = require('../../models');
const AppError = require('../../utils/AppError');

// CRUD puro de UserMembership. A resolução de roles/permissões efetivas vive em
// effectivePermissions.service.js.

async function createMembership(payload, actorUserId, transaction) {
  const { userId, groupId, companyId, unitId, roleId, status } = payload;
  if (!userId || !groupId || !companyId) {
    throw AppError.badRequest('userId, groupId e companyId são obrigatórios.', 'MEMBERSHIP_VALIDATION');
  }

  if (unitId) {
    const unit = await Unit.findOne({ where: { id: unitId, companyId }, transaction });
    if (!unit) {
      throw AppError.badRequest('Unidade informada não pertence à empresa informada.', 'MEMBERSHIP_UNIT_MISMATCH');
    }
  }
  if (roleId) {
    const role = await Role.findOne({ where: { id: roleId, companyId }, transaction });
    if (!role) {
      throw AppError.badRequest('Papel (role) informado não pertence à empresa informada.', 'MEMBERSHIP_ROLE_MISMATCH');
    }
  }

  const company = await Company.findOne({ where: { id: companyId, groupId } });
  if (!company) {
    throw AppError.badRequest('Empresa informada não pertence ao grupo informado.', 'MEMBERSHIP_COMPANY_MISMATCH');
  }

  return UserMembership.create(
    {
      userId,
      groupId,
      companyId,
      unitId: unitId || null,
      roleId: roleId || null,
      status: status || 'ACTIVE',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
}

async function listMemberships({ userId, companyId }, transaction) {
  const where = {};
  if (userId) where.userId = userId;
  if (companyId) where.companyId = companyId;
  return UserMembership.findAll({
    where,
    include: [
      { model: Role, as: 'role', required: false },
      { model: Unit, as: 'unit', required: false },
      { model: Company, as: 'company', required: false },
    ],
    order: [['created_at', 'DESC']],
    transaction,
  });
}

async function revokeMembership(id, actorUserId, transaction) {
  const membership = await UserMembership.findByPk(id, { transaction });
  if (!membership) {
    throw AppError.notFound('Vínculo (membership) não encontrado.', 'MEMBERSHIP_NOT_FOUND');
  }
  membership.status = 'REVOKED';
  membership.updatedBy = actorUserId || null;
  await membership.save({ transaction });
  return membership;
}

module.exports = { createMembership, listMemberships, revokeMembership };
