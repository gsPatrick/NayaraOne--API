'use strict';

const { Unit, Company } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * "core"."units" tem RLS (`company_id = current_setting('app.company_id', true)`), então
 * toda query aqui recebe `transaction` já aberta por `req.withTenantTransaction`
 * (ver src/middlewares/tenant.middleware.js) — nunca uma query solta fora dela.
 */
async function createUnit(payload, actorUserId, transaction) {
  const { companyId, groupId, name, code, status } = payload;
  if (!companyId || !groupId || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "name" são obrigatórios.', 'UNIT_VALIDATION');
  }
  const company = await Company.findOne({ where: { id: companyId, groupId }, transaction });
  if (!company) {
    throw AppError.badRequest('Empresa informada não pertence ao grupo informado ou não existe.', 'UNIT_COMPANY_MISMATCH');
  }
  return Unit.create(
    {
      groupId,
      companyId,
      name,
      code: code || null,
      status: status || 'ACTIVE',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
}

async function listUnits(transaction) {
  return Unit.findAll({ order: [['created_at', 'DESC']], transaction });
}

async function getUnit(id, transaction) {
  const unit = await Unit.findByPk(id, { transaction });
  if (!unit) throw AppError.notFound('Unidade não encontrada.', 'UNIT_NOT_FOUND');
  return unit;
}

async function updateUnit(id, payload, actorUserId, transaction) {
  const unit = await getUnit(id, transaction);
  const { name, code, status } = payload;
  if (name !== undefined) unit.name = name;
  if (code !== undefined) unit.code = code;
  if (status !== undefined) unit.status = status;
  unit.updatedBy = actorUserId || null;
  await unit.save({ transaction });
  return unit;
}

async function deleteUnit(id, actorUserId, transaction) {
  const unit = await getUnit(id, transaction);
  unit.deletedBy = actorUserId || null;
  await unit.save({ transaction });
  await unit.destroy({ transaction });
  return { id };
}

module.exports = { createUnit, listUnits, getUnit, updateUnit, deleteUnit };
