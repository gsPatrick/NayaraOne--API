'use strict';

const { InventoryCount, InventoryCountItem, InventoryStockBalance } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { recordMovement } = require('./movements.service');
const { publishCountCompleted } = require('./inventoryEvents.service');

// Guia do Marcelo §8/item 10 do Caderno: contagem NUNCA altera saldo direto (EST-TS-09) — o
// fechamento só trava expected_quantity/divergence; ajuste de verdade é um ato separado e
// aprovado (applyAdjustment -> movements.service ADJUSTMENT, com reason obrigatório).
async function openCount(payload, actorUserId, transaction) {
  const { groupId, companyId, locationId, projectId } = payload;
  if (!groupId || !companyId || !locationId) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "locationId" são obrigatórios.', 'INVENTORY_COUNT_VALIDATION');
  }
  const count = await InventoryCount.create(
    { groupId, companyId, locationId, projectId: projectId || null, status: 'OPEN', createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );
  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'INVENTORY_COUNT_OPENED', entityType: 'InventoryCount', entityId: count.id, reason: 'Inventário físico aberto.' },
    transaction
  );
  return count;
}

async function addCountItem(countId, payload, transaction) {
  const { inventoryItemId, countedQuantity } = payload;
  if (!inventoryItemId || countedQuantity == null || Number(countedQuantity) < 0) {
    throw AppError.badRequest('"inventoryItemId" e "countedQuantity" (>= 0) são obrigatórios.', 'INVENTORY_COUNT_VALIDATION');
  }
  const count = await InventoryCount.findByPk(countId, { transaction });
  if (!count) throw AppError.notFound('Inventário não encontrado.', 'INVENTORY_COUNT_NOT_FOUND');
  if (count.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível contar itens em um inventário OPEN (atual: ${count.status}).`, 'INVENTORY_COUNT_INVALID_TRANSITION');
  }

  const [line, created] = await InventoryCountItem.findOrCreate({
    where: { countId, inventoryItemId },
    defaults: { groupId: count.groupId, companyId: count.companyId, countId, inventoryItemId, countedQuantity },
    transaction,
  });
  if (!created) {
    line.countedQuantity = countedQuantity;
    await line.save({ transaction });
  }
  return line;
}

async function completeCount(countId, actorUserId, transaction) {
  const count = await InventoryCount.findByPk(countId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!count) throw AppError.notFound('Inventário não encontrado.', 'INVENTORY_COUNT_NOT_FOUND');
  if (count.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível fechar um inventário OPEN (atual: ${count.status}).`, 'INVENTORY_COUNT_INVALID_TRANSITION');
  }

  const items = await InventoryCountItem.findAll({ where: { countId }, transaction });
  for (const line of items) {
    const balance = await InventoryStockBalance.findOne({
      where: { inventoryItemId: line.inventoryItemId, locationId: count.locationId },
      transaction,
    });
    const expected = balance ? Number(balance.quantityOnHand) : 0;
    line.expectedQuantity = expected;
    line.divergence = Number(line.countedQuantity) - expected;
    await line.save({ transaction });
  }

  count.status = 'COMPLETED';
  count.countedAt = new Date();
  count.updatedBy = actorUserId || null;
  await count.save({ transaction });

  await publishCountCompleted(count, transaction);

  await registrarAuditoria(
    { groupId: count.groupId, companyId: count.companyId, actorUserId, action: 'INVENTORY_COUNT_COMPLETED', entityType: 'InventoryCount', entityId: count.id, reason: 'Inventário físico fechado — divergências calculadas, saldo não alterado.' },
    transaction
  );

  return getCount(count.id, transaction);
}

async function getCount(countId, transaction) {
  const count = await InventoryCount.findByPk(countId, { include: [{ model: InventoryCountItem, as: 'items' }], transaction });
  if (!count) throw AppError.notFound('Inventário não encontrado.', 'INVENTORY_COUNT_NOT_FOUND');
  return count;
}

async function listCounts(transaction, { status } = {}) {
  const where = {};
  if (status) where.status = status;
  return InventoryCount.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

// EST-TS-09: divergência vira "proposal" — só este endpoint, com approve explícito e reason,
// efetiva o ADJUSTMENT. Chamar de novo sobre a mesma linha é idempotente (idempotencyKey por
// count_item) e, de qualquer forma, bloqueado pelo check adjustmentMovementId != null.
async function applyAdjustment(countItemId, actor, transaction) {
  if (!actor.canApprove) {
    throw AppError.forbidden('Aplicar ajuste de inventário exige a permissão inventory:approve.', 'INVENTORY_COUNT_APPROVAL_REQUIRED');
  }
  const line = await InventoryCountItem.findByPk(countItemId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!line) throw AppError.notFound('Linha de contagem não encontrada.', 'INVENTORY_COUNT_ITEM_NOT_FOUND');
  if (line.adjustmentMovementId) return line;
  if (line.divergence == null || Number(line.divergence) === 0) {
    throw AppError.badRequest('Esta linha não tem divergência a ajustar.', 'INVENTORY_COUNT_NO_DIVERGENCE');
  }

  const count = await InventoryCount.findByPk(line.countId, { transaction });
  const divergence = Number(line.divergence);

  const movement = await recordMovement(
    {
      groupId: line.groupId,
      companyId: line.companyId,
      inventoryItemId: line.inventoryItemId,
      movementType: 'ADJUSTMENT',
      quantity: Math.abs(divergence),
      destinationLocationId: divergence > 0 ? count.locationId : undefined,
      sourceLocationId: divergence < 0 ? count.locationId : undefined,
      projectId: count.projectId,
      sourceType: 'COUNT',
      sourceId: count.id,
      idempotencyKey: `count-item:${line.id}`,
      reason: `Ajuste de inventário físico ${count.id} — divergência de ${divergence}.`,
    },
    actor,
    transaction
  );

  line.adjustmentMovementId = movement.id;
  await line.save({ transaction });

  return line;
}

module.exports = { openCount, addCountItem, completeCount, getCount, listCounts, applyAdjustment };
