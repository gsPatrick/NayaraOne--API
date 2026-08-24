'use strict';

const { ResultCenter } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

async function createResultCenter(payload, actorUserId, transaction) {
  const { groupId, companyId, code, name } = payload;
  if (!groupId || !companyId || !code || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId", "code" e "name" são obrigatórios.', 'FINANCE_RESULT_CENTER_VALIDATION');
  }
  const resultCenter = await ResultCenter.create(
    { groupId, companyId, code, name, createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.result_center.create',
      entityType: 'ResultCenter',
      entityId: resultCenter.id,
      afterJson: resultCenter.toJSON(),
      reason: `Centro de resultado "${resultCenter.code} — ${resultCenter.name}" criado.`,
    },
    transaction
  );

  return resultCenter;
}

async function listResultCenters(transaction) {
  return ResultCenter.findAll({ order: [['code', 'ASC']], transaction });
}

async function getResultCenter(id, transaction) {
  const resultCenter = await ResultCenter.findByPk(id, { transaction });
  if (!resultCenter) throw AppError.notFound('Centro de resultado não encontrado.', 'FINANCE_RESULT_CENTER_NOT_FOUND');
  return resultCenter;
}

async function updateResultCenter(id, payload, actorUserId, transaction) {
  const resultCenter = await getResultCenter(id, transaction);
  const beforeJson = resultCenter.toJSON();
  const { code, name } = payload;
  if (code !== undefined) resultCenter.code = code;
  if (name !== undefined) resultCenter.name = name;
  resultCenter.updatedBy = actorUserId || null;
  await resultCenter.save({ transaction });

  await registrarAuditoria(
    {
      groupId: resultCenter.groupId,
      companyId: resultCenter.companyId,
      actorUserId,
      action: 'finance.result_center.update',
      entityType: 'ResultCenter',
      entityId: resultCenter.id,
      beforeJson,
      afterJson: resultCenter.toJSON(),
      reason: `Centro de resultado "${resultCenter.code}" atualizado.`,
    },
    transaction
  );

  return resultCenter;
}

async function deleteResultCenter(id, actorUserId, transaction) {
  const resultCenter = await getResultCenter(id, transaction);
  const beforeJson = resultCenter.toJSON();
  resultCenter.deletedBy = actorUserId || null;
  await resultCenter.save({ transaction });
  await resultCenter.destroy({ transaction });

  await registrarAuditoria(
    {
      groupId: resultCenter.groupId,
      companyId: resultCenter.companyId,
      actorUserId,
      action: 'finance.result_center.delete',
      entityType: 'ResultCenter',
      entityId: resultCenter.id,
      beforeJson,
      reason: `Centro de resultado "${resultCenter.code}" excluído.`,
    },
    transaction
  );

  return { id };
}

module.exports = { createResultCenter, listResultCenters, getResultCenter, updateResultCenter, deleteResultCenter };
