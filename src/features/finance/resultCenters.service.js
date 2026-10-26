'use strict';

const { ResultCenter, sequelize } = require('../../models');
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
      afterJson: { ...beforeJson, deletedAt: new Date(), deletedBy: actorUserId || null, situacao: 'excluído (exclusão lógica — o registro continua no banco)' },
      reason: `Centro de resultado "${resultCenter.code}" excluído.`,
    },
    transaction
  );

  return { id };
}

// Mesmo raciocínio/comentário de getOrCreateDefaultCostCenter (costCenters.service.js) — ver
// lá para o contexto completo do porquê este helper existe.
// Duas primeiras confirmações simultâneas não criam dois centros: o trava serializa a criação (e o
// índice único parcial da migration 643 garante no banco). A criação fica na auditoria.
async function getOrCreateDefaultResultCenter(groupId, companyId, code, name, transaction, actorUserId = null) {
  const existing = await ResultCenter.findOne({ where: { groupId, companyId, code }, transaction });
  if (existing) return existing;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
    replacements: { lockKey: `default_result_center:${companyId}:${code}` },
    transaction,
  });
  const again = await ResultCenter.findOne({ where: { groupId, companyId, code }, transaction });
  if (again) return again;
  const created = await ResultCenter.create({ groupId, companyId, code, name, createdBy: actorUserId || null, updatedBy: actorUserId || null }, { transaction });
  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.result_center.create',
      entityType: 'ResultCenter',
      entityId: created.id,
      afterJson: created.toJSON(),
      reason: `Centro de resultado padrão "${code} — ${name}" criado automaticamente no primeiro uso.`,
    },
    transaction
  );
  return created;
}

module.exports = {
  createResultCenter,
  listResultCenters,
  getResultCenter,
  updateResultCenter,
  deleteResultCenter,
  getOrCreateDefaultResultCenter,
};
