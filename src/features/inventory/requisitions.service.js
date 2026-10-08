'use strict';

const { InventoryRequisition, InventoryRequisitionItem, InventoryLocation, InventoryItem, ProjectStage } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { recordMovement } = require('./movements.service');
const { publishRequisitionCreated } = require('./inventoryEvents.service');

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
    if (!line.inventoryItemId || line.quantity == null || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) {
      throw AppError.badRequest('Cada item precisa de "inventoryItemId" e "quantity" > 0.', 'INVENTORY_REQUISITION_VALIDATION');
    }
  }

  // GAP REAL CORRIGIDO (auditoria de conformidade contratual Marco 7, 2026-10-07): EST-004 exige
  // project_id/stage_id — stageId era gravado sem nenhuma validação (aceitava etapa de OUTRA obra
  // ou etapa sem obra nenhuma). Mesmo padrão de materialRequests.service.js#createMaterialRequest.
  if (stageId) {
    if (!projectId) {
      throw AppError.badRequest('"stageId" exige "projectId" (a etapa pertence a uma obra — EST-004).', 'INVENTORY_REQUISITION_VALIDATION');
    }
    const stage = await ProjectStage.findOne({ where: { id: stageId, projectId }, transaction });
    if (!stage) {
      throw AppError.badRequest('"stageId" não corresponde a uma etapa desta obra.', 'INVENTORY_REQUISITION_STAGE_INVALID');
    }
  }

  const warehouse = await InventoryLocation.findByPk(warehouseLocationId, { transaction });
  if (!warehouse) throw AppError.notFound('Local de origem (almoxarifado) não encontrado.', 'INVENTORY_LOCATION_NOT_FOUND');

  // GAP REAL CORRIGIDO (auditoria de conformidade EST-004, 2026-10-08): a validação acima só
  // cobria a direção "projectId informado sem projectLocationId" — faltava a direção simétrica.
  // Sem ela, uma requisição apontando "projectLocationId" para um InventoryLocation
  // PROJECT_SITE sem informar projectId/stageId era aceita normalmente, e o OUT gerado depois em
  // issueRequisition saía com projectId: null — um movimento tocando local de obra sem vínculo
  // de obra, quebrando a rastreabilidade exigida pelo EST-004 (mesmo padrão já corrigido em
  // movements.service.js#recordMovement e counts.service.js#openCount).
  if (projectLocationId && !projectId) {
    const projectLocation = await InventoryLocation.findOne({ where: { id: projectLocationId, groupId, companyId }, transaction });
    if (!projectLocation) throw AppError.notFound('Local de destino no canteiro (projectLocationId) não encontrado.', 'INVENTORY_LOCATION_NOT_FOUND');
    if (projectLocation.locationType === 'PROJECT_SITE') {
      throw AppError.badRequest(
        'Local de destino é de obra (PROJECT_SITE) — informe "projectId" (e, se aplicável, "stageId") para vincular a requisição à obra (EST-004).',
        'REQUISITION_PROJECT_LOCATION_REQUIRES_PROJECT'
      );
    }
  }

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
    const item = await InventoryItem.findOne({ where: { id: line.inventoryItemId, groupId, companyId }, transaction });
    if (!item) throw AppError.notFound(`Item de estoque "${line.inventoryItemId}" não encontrado.`, 'INVENTORY_ITEM_NOT_FOUND');
    await InventoryRequisitionItem.create(
      { groupId, companyId, requisitionId: requisition.id, inventoryItemId: line.inventoryItemId, quantity: line.quantity },
      { transaction }
    );
  }

  await publishRequisitionCreated(requisition, transaction);

  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'INVENTORY_REQUISITION_CREATED', entityType: 'InventoryRequisition', entityId: requisition.id, reason: 'Requisição de material criada.' },
    transaction
  );

  return getRequisition(requisition.id, groupId, companyId, transaction);
}

async function getRequisition(requisitionId, groupId, companyId, transaction) {
  const requisition = await InventoryRequisition.findOne({
    where: { id: requisitionId, groupId, companyId },
    include: [{ model: InventoryRequisitionItem, as: 'items' }],
    transaction,
  });
  if (!requisition) throw AppError.notFound('Requisição não encontrada.', 'INVENTORY_REQUISITION_NOT_FOUND');
  return requisition;
}

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 53, 2026-10-05): listRequisitions
// nunca incluía os itens (só getRequisition incluía) — a tela de lista só conseguia mostrar o
// status agregado, nunca quais itens/quantidades foram solicitados, mesmo padrão de bug já
// corrigido em R52 pra comparação de cotações (só total, nunca item a item).
async function listRequisitions(groupId, companyId, transaction, { status, projectId } = {}) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  if (projectId) where.projectId = projectId;
  return InventoryRequisition.findAll({
    where,
    include: [{ model: InventoryRequisitionItem, as: 'items' }],
    order: [['created_at', 'DESC']],
    transaction,
  });
}

async function decideRequisition(requisitionId, decision, actorUserId, groupId, companyId, transaction) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw AppError.badRequest('"decision" precisa ser "APPROVED" ou "REJECTED".', 'INVENTORY_REQUISITION_VALIDATION');
  }
  const requisition = await InventoryRequisition.findOne({ where: { id: requisitionId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
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

async function issueRequisition(requisitionId, actor, groupId, companyId, transaction) {
  const requisition = await InventoryRequisition.findOne({ where: { id: requisitionId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!requisition) throw AppError.notFound('Requisição não encontrada.', 'INVENTORY_REQUISITION_NOT_FOUND');
  if (requisition.status !== 'APPROVED') {
    throw AppError.badRequest(`Só é possível entregar uma requisição em APPROVED (atual: ${requisition.status}).`, 'INVENTORY_REQUISITION_INVALID_TRANSITION');
  }
  const items = await InventoryRequisitionItem.findAll({ where: { requisitionId: requisition.id, groupId, companyId }, transaction });

  for (const line of items) {
    await recordMovement(
      {
        groupId: requisition.groupId,
        companyId: requisition.companyId,
        inventoryItemId: line.inventoryItemId,
        projectId: requisition.projectId,
        stageId: requisition.stageId,
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
          projectId: requisition.projectId,
          stageId: requisition.stageId,
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
