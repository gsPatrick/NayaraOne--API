'use strict';

const { Inspection, InspectionItem } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishInspectionCompleted } = require('./legalEvents.service');

const INSPECTION_TYPES = ['CHECK_IN', 'CHECK_OUT', 'PERIODIC'];
const CONDITIONS = ['GOOD', 'REGULAR', 'DAMAGED'];

async function createInspection(payload, actorUserId, transaction) {
  const { groupId, companyId, propertyId, contractId, inspectorUserId, inspectionType, scheduledAt } = payload;
  if (!groupId || !companyId || !propertyId || !inspectionType) {
    throw AppError.badRequest('Os campos "groupId", "companyId", "propertyId" e "inspectionType" são obrigatórios.', 'LEGAL_INSPECTION_VALIDATION');
  }
  if (!INSPECTION_TYPES.includes(inspectionType)) {
    throw AppError.badRequest(`"inspectionType" deve ser um de: ${INSPECTION_TYPES.join(', ')}.`, 'LEGAL_INSPECTION_VALIDATION');
  }

  const inspection = await Inspection.create(
    {
      groupId,
      companyId,
      propertyId,
      contractId: contractId || null,
      inspectorUserId: inspectorUserId || null,
      inspectionType,
      scheduledAt: scheduledAt || null,
      status: 'SCHEDULED',
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
      action: 'legal.inspection.create',
      entityType: 'Inspection',
      entityId: inspection.id,
      afterJson: inspection.toJSON(),
      reason: `Vistoria "${inspectionType}" agendada para o imóvel ${propertyId}.`,
    },
    transaction
  );

  return inspection;
}

async function listInspections(transaction, filters = {}) {
  const where = {};
  if (filters.propertyId) where.propertyId = filters.propertyId;
  if (filters.contractId) where.contractId = filters.contractId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.inspectionType) where.inspectionType = String(filters.inspectionType).toUpperCase();
  return Inspection.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getInspection(id, transaction) {
  const inspection = await Inspection.findByPk(id, { transaction });
  if (!inspection) throw AppError.notFound('Vistoria não encontrada.', 'LEGAL_INSPECTION_NOT_FOUND');
  return inspection;
}

async function completeInspection(id, actorUserId, transaction) {
  const inspection = await getInspection(id, transaction);
  if (inspection.status === 'COMPLETED') {
    throw AppError.conflict('Vistoria já está concluída.', 'LEGAL_INSPECTION_ALREADY_COMPLETED');
  }
  const beforeJson = inspection.toJSON();
  inspection.status = 'COMPLETED';
  inspection.completedAt = new Date();
  inspection.updatedBy = actorUserId || null;
  await inspection.save({ transaction });

  await publishInspectionCompleted(inspection, transaction);

  await registrarAuditoria(
    {
      groupId: inspection.groupId,
      companyId: inspection.companyId,
      actorUserId,
      action: 'legal.inspection.complete',
      entityType: 'Inspection',
      entityId: inspection.id,
      beforeJson,
      afterJson: inspection.toJSON(),
      reason: `Vistoria ${inspection.id} concluída.`,
    },
    transaction
  );

  return inspection;
}

async function addInspectionItem(inspectionId, payload, actorUserId, transaction) {
  const inspection = await getInspection(inspectionId, transaction);
  const { itemName, condition, notes } = payload;
  if (!itemName) {
    throw AppError.badRequest('O campo "itemName" é obrigatório.', 'LEGAL_INSPECTION_ITEM_VALIDATION');
  }
  if (condition !== undefined && condition !== null && !CONDITIONS.includes(condition)) {
    throw AppError.badRequest(`"condition" deve ser um de: ${CONDITIONS.join(', ')}.`, 'LEGAL_INSPECTION_ITEM_VALIDATION');
  }

  const item = await InspectionItem.create(
    {
      groupId: inspection.groupId,
      companyId: inspection.companyId,
      inspectionId: inspection.id,
      itemName,
      condition: condition || null,
      notes: notes || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: inspection.groupId,
      companyId: inspection.companyId,
      actorUserId,
      action: 'legal.inspection_item.create',
      entityType: 'InspectionItem',
      entityId: item.id,
      afterJson: item.toJSON(),
      reason: `Item "${itemName}" registrado na vistoria ${inspection.id}.`,
    },
    transaction
  );

  return item;
}

async function listInspectionItems(inspectionId, transaction) {
  return InspectionItem.findAll({ where: { inspectionId }, transaction });
}

/**
 * compareInspections — compara os itens de uma vistoria de entrada com uma de saída,
 * retornando as divergências (itens cuja `condition` mudou).
 *
 * LIMITAÇÃO ASSUMIDA (decisão de engenharia, não resolvida por FK): a comparação casa itens
 * pelo campo textual `item_name` — não existe (nem foi pedido) um catálogo de itens
 * padronizado com FK entre InspectionItem de vistorias diferentes. Isso significa que, se o
 * `item_name` for digitado de forma inconsistente entre a vistoria de entrada e a de saída
 * (ex.: "Piso da sala" vs "Piso sala"), o item não será corretamente pareado. Itens presentes
 * em só uma das vistorias são reportados separadamente (added/removed) em vez de gerar falso
 * positivo de divergência de condição.
 */
async function compareInspections(entryInspectionId, exitInspectionId, transaction) {
  const entryInspection = await getInspection(entryInspectionId, transaction);
  const exitInspection = await getInspection(exitInspectionId, transaction);

  const entryItems = await listInspectionItems(entryInspectionId, transaction);
  const exitItems = await listInspectionItems(exitInspectionId, transaction);

  const entryByName = new Map(entryItems.map((i) => [i.itemName, i]));
  const exitByName = new Map(exitItems.map((i) => [i.itemName, i]));

  const divergences = [];
  const onlyInEntry = [];
  const onlyInExit = [];

  for (const [name, entryItem] of entryByName.entries()) {
    const exitItem = exitByName.get(name);
    if (!exitItem) {
      onlyInEntry.push({ itemName: name, entryCondition: entryItem.condition });
      continue;
    }
    if (entryItem.condition !== exitItem.condition) {
      divergences.push({
        itemName: name,
        entryCondition: entryItem.condition,
        exitCondition: exitItem.condition,
      });
    }
  }
  for (const [name, exitItem] of exitByName.entries()) {
    if (!entryByName.has(name)) {
      onlyInExit.push({ itemName: name, exitCondition: exitItem.condition });
    }
  }

  return {
    entryInspectionId: entryInspection.id,
    exitInspectionId: exitInspection.id,
    divergences,
    onlyInEntry,
    onlyInExit,
  };
}

module.exports = {
  createInspection,
  listInspections,
  getInspection,
  completeInspection,
  addInspectionItem,
  listInspectionItems,
  compareInspections,
  INSPECTION_TYPES,
  CONDITIONS,
};
