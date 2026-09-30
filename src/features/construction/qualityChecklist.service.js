'use strict';

const { QualityChecklistItem } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

// DECISÃO DE ENGENHARIA (M6-12): categorias fixas escolhidas a partir dos ofícios de obra mais
// comuns (lista não documentada na fonte — ver comentário da migration
// 20260101000219-add-category-to-quality_checklist_items.js). Mantém o item como campo livre
// (texto da verificação específica), mas classifica o TIPO do item, saindo do "texto livre
// puro" anterior.
const CATEGORIES = ['PINTURA', 'HIDRAULICA', 'ELETRICA', 'ESTRUTURA', 'ACABAMENTO', 'ALVENARIA', 'OUTROS'];

async function createQualityItem(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, projectStageId, item, category } = payload;
  if (!groupId || !companyId || !item) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "item" são obrigatórios.', 'QUALITY_ITEM_VALIDATION');
  }
  const normalizedCategory = category ? String(category).toUpperCase() : 'OUTROS';
  if (!CATEGORIES.includes(normalizedCategory)) {
    throw AppError.badRequest(`"category" deve ser um de: ${CATEGORIES.join(', ')}.`, 'QUALITY_ITEM_CATEGORY_INVALID');
  }

  const checklistItem = await QualityChecklistItem.create(
    {
      groupId,
      companyId,
      projectId,
      projectStageId: projectStageId || null,
      item,
      category: normalizedCategory,
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

module.exports = { createQualityItem, listQualityItems, getQualityItem, checkQualityItem, CATEGORIES };
