'use strict';

const { InventoryRequisition, InventoryRequisitionItem, InventoryLocation, InventoryItem } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { recordMovement } = require('./movements.service');

// Guia do Marcelo §5: Saída para obra — REQUESTED -> APPROVED/REJECTED -> ISSUED (OUT com
// project_id/stage_id — EST-004). "Separação gera reserva opcional" do Caderno não é
// implementada aqui como reserva de saldo (não há tabela de reserva no DoD mínimo); a baixa
// (issue) é o ponto de verdade único de saída de saldo, idêntico ao padrão já usado em receipts.
const STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'ISSUED'];

async function createRequisition(payload, actorUserId, transaction) {
  const { groupId, companyId, warehouseLocationId, projectLocationId, projectId, stageId, notes, items } = payload;

  if (!groupId || !companyId || !warehouseLocationId || !Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "warehouseLocationId" e "items" (não vazio) são obrigatórios.',
      'INVENTORY_REQUISITION_VALIDATION'
    );
  }
  // EST-004: material atribuído à obra precisa de project_id/stage_id.
  if (projectId && !projectLocationId) {
    throw AppError.badRequest('Requisição vinculada a obra exige "projectLocationId" (local de destino no canteiro).', 'INVENTORY_REQUISITION_VALIDATION');
  }
  for (const line of items) {
    if (!line.inventoryItemId || line.quantity == null || Number(line.quantity) <= 0) {
      throw AppError.badRequest('Cada item precisa de "inventoryItemId" e "quantity" > 0.', 'INVENTORY_REQUISITION_VALIDATION');
    }
  }

  const warehouse = await InventoryLocation.findByPk(warehouseLocationId, { transaction });
  if (!warehouse) throw AppError.notFound('Local de origem (almoxarifado) não encontrado.', 'INVENTORY_LOCATION_NOT_FOUND');

  const requisition = await InventoryRequisition.create(
    {
      groupId,
      companyId,
      warehouseLocationId,
      projectLocationId: projectLocationId || null,
      projectId: projectId || null,
      stageId: stageId || null,
      notes: notes || null,
      status: 'REQUESTED',
      requestedByUserId: actorUserId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  for (const line of items) {
    const item = await InventoryItem.findByPk(line.inventoryItemId, { transaction });
    if (!item) throw AppError.notFound(`Item de estoque "${line.inventoryItemId}" não encontrado.`, 'INVENTORY_ITEM_NOT_FOUND');
    await InventoryRequisitionItem.create(
      { groupId, companyId, requisitionId: requisition.id, inventoryItemId: line.inventoryItemId, quantity: line.quantity },
      { transaction }
    );
  }

  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'INVENTORY_REQUISITION_CREATED', entityType: 'InventoryRequisition', entityId: requisition.id, reason: 'Requisição de material criada.' },
    transaction
  );

  return getRequisition(requisition.id, transaction);
}

async function getRequisition(requisitionId, transaction) {
  const requisition = await InventoryRequisition.findByPk(requisitionId, {
    include: [{ model: InventoryRequisitionItem, as: 'items' }],
    transaction,
  });
  if (!requisition) throw AppError.notFound('Requisição não encontrada.', 'INVENTORY_REQUISITION_NOT_FOUND');
  return requisition;
}

async function listRequisitions(transaction, { status, projectId } = {}) {
  const where = {};
  if (status) where.status = status;
  if (projectId) where.projectId = projectId;
  return InventoryRequisition.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function decideRequisition(requisitionId, decision, actorUserId, transaction) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw AppError.badRequest('"decision" precisa ser "APPROVED" ou "REJECTED".', 'INVENTORY_REQUISITION_VALIDATION');
  }
  const requisition = await InventoryRequisition.findByPk(requisitionId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!requisition) throw AppError.notFound('Requisição não encontrada.', 'INVENTORY_REQUISITION_NOT_FOUND');
  if (requisition.status !== 'REQUESTED') {
    throw AppError.badRequest(`Só é possível decidir uma requisição em REQUESTED (atual: ${requisition.status}).`, 'INVENTORY_REQUISITION_INVALID_TRANSITION');
  }
  requisition.status = decision;
  requisition.approvedByUserId = actorUserId || null;
  requisition.updatedBy = actorUserId || null;
  await requisition.save({ transaction });
  return requisition;
}

async function issueRequisition(requisitionId, actor, transaction) {
  const requisition = await InventoryRequisition.findByPk(requisitionId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!requisition) throw AppError.notFound('Requisição não encontrada.', 'INVENTORY_REQUISITION_NOT_FOUND');
  if (requisition.status !== 'APPROVED') {
    throw AppError.badRequest(`Só é possível entregar uma requisição em APPROVED (atual: ${requisition.status}).`, 'INVENTORY_REQUISITION_INVALID_TRANSITION');
  }
  const items = await InventoryRequisitionItem.findAll({ where: { requisitionId: requisition.id }, transaction });

  for (const line of items) {
    await recordMovement(
      {
        groupId: requisition.groupId,
        companyId: requisition.companyId,
        inventoryItemId: line.inventoryItemId,
        projectId: requisition.projectId,
        movementType: 'OUT',
        quantity: Number(line.quantity) - Number(line.issuedQuantity),
        sourceLocationId: requisition.warehouseLocationId,
        sourceType: 'REQUISITION',
        sourceId: requisition.id,
        idempotencyKey: `req:${requisition.id}:item:${line.id}`,
      },
      actor,
      transaction
    );
    line.issuedQuantity = line.quantity;
    await line.save({ transaction });
  }

  requisition.status = 'ISSUED';
  requisition.updatedBy = actor.userId || null;
  await requisition.save({ transaction });

  // Se a requisição tem destino no canteiro (projectLocationId), a baixa do almoxarifado
  // precisa ser completada por uma entrada no local da obra — modelada como TRANSFER, não como
  // dois OUT, pra manter atomicidade igual ao resto do ledger (EST-003).
  if (requisition.projectLocationId) {
    for (const line of items) {
      await recordMovement(
        {
          groupId: requisition.groupId,
          companyId: requisition.companyId,
          inventoryItemId: line.inventoryItemId,
          movementType: 'IN',
          quantity: line.quantity,
          destinationLocationId: requisition.projectLocationId,
          sourceType: 'REQUISITION',
          sourceId: requisition.id,
          idempotencyKey: `req:${requisition.id}:item:${line.id}:site-in`,
        },
        actor,
        transaction
      );
    }
  }

  await registrarAuditoria(
    { groupId: requisition.groupId, companyId: requisition.companyId, actorUserId: actor.userId, action: 'INVENTORY_REQUISITION_ISSUED', entityType: 'InventoryRequisition', entityId: requisition.id, reason: 'Requisição entregue — baixa de estoque gerada.' },
    transaction
  );

  return requisition;
}

module.exports = { STATUSES, createRequisition, getRequisition, listRequisitions, decideRequisition, issueRequisition };
