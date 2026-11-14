'use strict';

const { Unit, Company } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const UNIT_STATUSES = ['ACTIVE', 'INACTIVE'];

/**
 * Matriz M3-05 (verificação independente de 11/11/2026): "Empresas e unidades com criação, alteração, inativação e
 * permissões" — a unidade não gravava auditoria. Criar, alterar e inativar unidade agora deixam registro no audit_log com
 * antes e depois (a unidade é da empresa do contexto, então o registro entra no contexto da própria requisição).
 */
async function auditUnit(unit, actorUserId, action, beforeJson, reason, transaction) {
  await registrarAuditoria(
    { groupId: unit.groupId, companyId: unit.companyId, actorUserId, action, entityType: 'Unit', entityId: unit.id, beforeJson: beforeJson || null, afterJson: unit.toJSON(), reason },
    transaction
  );
}

function normalizeStatus(status) {
  if (status === undefined) return undefined;
  const normalized = String(status).toUpperCase();
  if (!UNIT_STATUSES.includes(normalized)) {
    throw AppError.badRequest(`O campo "status" deve ser um de: ${UNIT_STATUSES.join(', ')}.`, 'UNIT_VALIDATION');
  }
  return normalized;
}

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
  const unit = await Unit.create(
    {
      groupId,
      companyId,
      name,
      code: code || null,
      status: normalizeStatus(status) || 'ACTIVE',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  await auditUnit(unit, actorUserId, 'unit.create', null, `Unidade "${unit.name}" cadastrada.`, transaction);
  return unit;
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
  const beforeJson = unit.toJSON();
  const { name, code, status } = payload;
  if (name !== undefined) {
    if (!String(name).trim()) throw AppError.badRequest('O campo "name" não pode ficar vazio.', 'UNIT_VALIDATION');
    unit.name = name;
  }
  if (code !== undefined) unit.code = code;
  if (status !== undefined) unit.status = normalizeStatus(status);
  unit.updatedBy = actorUserId || null;
  await unit.save({ transaction });
  const action = beforeJson.status !== unit.status && unit.status === 'INACTIVE' ? 'unit.inactivate' : 'unit.update';
  await auditUnit(unit, actorUserId, action, beforeJson, `Unidade "${unit.name}" ${action === 'unit.inactivate' ? 'inativada' : 'atualizada'}.`, transaction);
  return unit;
}

async function deleteUnit(id, actorUserId, transaction) {
  const unit = await getUnit(id, transaction);
  const beforeJson = unit.toJSON();
  unit.deletedBy = actorUserId || null;
  await unit.save({ transaction });
  await unit.destroy({ transaction });
  await auditUnit(unit, actorUserId, 'unit.delete', beforeJson, `Unidade "${unit.name}" excluída (exclusão lógica).`, transaction);
  return { id };
}

module.exports = { createUnit, listUnits, getUnit, updateUnit, deleteUnit };
