'use strict';

const { QualityChecklistItem } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

async function createQualityItem(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, projectStageId, item } = payload;
  if (!groupId || !companyId || !item) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "item" são obrigatórios.', 'QUALITY_ITEM_VALIDATION');
  }

  const checklistItem = await QualityChecklistItem.create(
    {
      groupId,
      companyId,
      projectId,
      projectStageId: projectStageId || null,
      item,
      status: 'PENDING',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.quality_item.create',
      entityType: 'QualityChecklistItem',
      entityId: checklistItem.id,
      afterJson: checklistItem.toJSON(),
      reason: `Item de qualidade "${item}" criado para a obra ${projectId}.`,
    },
    transaction
  );

  return checklistItem;
}

async function listQualityItems(projectId, transaction) {
  return QualityChecklistItem.findAll({ where: { projectId }, order: [['created_at', 'ASC']], transaction });
}

async function getQualityItem(id, transaction) {
  const item = await QualityChecklistItem.findByPk(id, { transaction });
  if (!item) throw AppError.notFound('Item de qualidade não encontrado.', 'QUALITY_ITEM_NOT_FOUND');
  return item;
}

const CHECK_STATUSES = ['PENDING', 'OK', 'NOT_OK'];

async function checkQualityItem(id, { status, notes }, actorUserId, transaction) {
  const item = await getQualityItem(id, transaction);
  const normalizedStatus = String(status || '').toUpperCase();
  if (!CHECK_STATUSES.includes(normalizedStatus)) {
    throw AppError.badRequest(`"status" deve ser um de: ${CHECK_STATUSES.join(', ')}.`, 'QUALITY_ITEM_STATUS_INVALID');
  }

  const beforeJson = item.toJSON();
  item.status = normalizedStatus;
  item.notes = notes !== undefined ? notes : item.notes;
  item.checkedByUserId = actorUserId || null;
  item.checkedAt = new Date();
  item.updatedBy = actorUserId || null;
  await item.save({ transaction });

  await registrarAuditoria(
    {
      groupId: item.groupId,
      companyId: item.companyId,
      actorUserId,
      action: 'construction.quality_item.check',
      entityType: 'QualityChecklistItem',
      entityId: item.id,
      beforeJson,
      afterJson: item.toJSON(),
      reason: `Item de qualidade "${item.item}" marcado como "${normalizedStatus}".`,
    },
    transaction
  );

  return item;
}

module.exports = { createQualityItem, listQualityItems, getQualityItem, checkQualityItem };
