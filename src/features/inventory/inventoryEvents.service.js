'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');

// Eventos mínimos do Caderno Marco 7 (seção 14): mesmo padrão de constructionEvents.service.js/
// legalEvents.service.js — Transactional Outbox, sempre na mesma transação da operação de
// negócio, idempotencyKey incluindo lockVersion/estado quando o mesmo aggregate pode repetir
// a transição (EST-TS-12: evento repetido é idempotente).

function publishItemCreated(item, transaction) {
  return publishDomainEvent(
    {
      groupId: item.groupId,
      companyId: item.companyId,
      aggregateType: 'InventoryItem',
      aggregateId: item.id,
      eventType: 'inventory.item.created',
      payload: { id: item.id, name: item.name, itemType: item.itemType },
      idempotencyKey: `inventory.item.created:${item.id}`,
    },
    transaction
  );
}

function publishReceiptCompleted(receipt, transaction) {
  return publishDomainEvent(
    {
      groupId: receipt.groupId,
      companyId: receipt.companyId,
      aggregateType: 'InventoryReceipt',
      aggregateId: receipt.id,
      eventType: 'inventory.receipt.completed',
      payload: { id: receipt.id, destinationLocationId: receipt.destinationLocationId },
      idempotencyKey: `inventory.receipt.completed:${receipt.id}`,
    },
    transaction
  );
}

function publishRequisitionCreated(requisition, transaction) {
  return publishDomainEvent(
    {
      groupId: requisition.groupId,
      companyId: requisition.companyId,
      aggregateType: 'InventoryRequisition',
      aggregateId: requisition.id,
      eventType: 'inventory.requisition.created',
      payload: { id: requisition.id, projectId: requisition.projectId },
      idempotencyKey: `inventory.requisition.created:${requisition.id}`,
    },
    transaction
  );
}

function publishMovementRecorded(movement, transaction) {
  return publishDomainEvent(
    {
      groupId: movement.groupId,
      companyId: movement.companyId,
      aggregateType: 'InventoryMovement',
      aggregateId: movement.id,
      eventType: 'inventory.movement.recorded',
      payload: { id: movement.id, movementType: movement.movementType, inventoryItemId: movement.inventoryItemId, quantity: movement.quantity },
      idempotencyKey: `inventory.movement.recorded:${movement.id}`,
    },
    transaction
  );
}

function publishStockLow(item, locationId, quantityOnHand, transaction) {
  return publishDomainEvent(
    {
      groupId: item.groupId,
      companyId: item.companyId,
      aggregateType: 'InventoryItem',
      aggregateId: item.id,
      eventType: 'inventory.stock.low',
      payload: { id: item.id, locationId, quantityOnHand, minimumQuantity: item.minimumQuantity },
      // EST-TS-12: o mesmo item pode cruzar o mínimo várias vezes — a chave inclui o saldo
      // resultante para não colidir indefinidamente enquanto o estoque permanecer baixo, mas
      // também não duplicar o MESMO cruzamento reprocessado (ex.: retry do job).
      idempotencyKey: `inventory.stock.low:${item.id}:${locationId}:${quantityOnHand}`,
    },
    transaction
  );
}

function publishToolLoanCreated(loan, transaction) {
  return publishDomainEvent(
    {
      groupId: loan.groupId,
      companyId: loan.companyId,
      aggregateType: 'InventoryToolLoan',
      aggregateId: loan.id,
      eventType: 'tool.loan.created',
      payload: { id: loan.id, assetId: loan.assetId, personUserId: loan.personUserId },
      idempotencyKey: `tool.loan.created:${loan.id}`,
    },
    transaction
  );
}

function publishToolLoanOverdue(loan, transaction) {
  return publishDomainEvent(
    {
      groupId: loan.groupId,
      companyId: loan.companyId,
      aggregateType: 'InventoryToolLoan',
      aggregateId: loan.id,
      eventType: 'tool.loan.overdue',
      payload: { id: loan.id, assetId: loan.assetId, dueAt: loan.dueAt },
      idempotencyKey: `tool.loan.overdue:${loan.id}:${loan.lockVersion}`,
    },
    transaction
  );
}

function publishToolReturned(loan, transaction) {
  return publishDomainEvent(
    {
      groupId: loan.groupId,
      companyId: loan.companyId,
      aggregateType: 'InventoryToolLoan',
      aggregateId: loan.id,
      eventType: 'tool.returned',
      payload: { id: loan.id, assetId: loan.assetId, conditionCode: loan.conditionCode },
      idempotencyKey: `tool.returned:${loan.id}`,
    },
    transaction
  );
}

function publishAssetTransferred(movement, transaction) {
  return publishDomainEvent(
    {
      groupId: movement.groupId,
      companyId: movement.companyId,
      aggregateType: 'Asset',
      aggregateId: movement.assetId,
      eventType: 'asset.transferred',
      payload: { assetId: movement.assetId, destinationLocationId: movement.destinationLocationId },
      idempotencyKey: `asset.transferred:${movement.id}`,
    },
    transaction
  );
}

// Venda/descarte/doação de patrimônio (Caderno §9). Não está na lista mínima de eventos da
// seção 14, mas mantém o módulo consistente: toda transição relevante do Asset publica evento.
// Baixa é terminal (um asset só é baixado uma vez), então a chave por asset já é única.
function publishAssetDisposed(asset, disposal, transaction) {
  return publishDomainEvent(
    {
      groupId: asset.groupId,
      companyId: asset.companyId,
      aggregateType: 'Asset',
      aggregateId: asset.id,
      eventType: 'asset.disposed',
      payload: {
        assetId: asset.id,
        disposalType: disposal.disposalType,
        disposalValue: disposal.disposalValue,
        financialEntryId: disposal.financialEntryId,
        movementId: disposal.movementId,
      },
      idempotencyKey: `asset.disposed:${asset.id}`,
    },
    transaction
  );
}

function publishMaintenanceOpened(order, transaction) {
  return publishDomainEvent(
    {
      groupId: order.groupId,
      companyId: order.companyId,
      aggregateType: 'InventoryMaintenanceOrder',
      aggregateId: order.id,
      eventType: 'maintenance.opened',
      payload: { id: order.id, assetId: order.assetId },
      idempotencyKey: `maintenance.opened:${order.id}`,
    },
    transaction
  );
}

function publishMaintenanceClosed(order, transaction) {
  return publishDomainEvent(
    {
      groupId: order.groupId,
      companyId: order.companyId,
      aggregateType: 'InventoryMaintenanceOrder',
      aggregateId: order.id,
      eventType: 'maintenance.closed',
      payload: { id: order.id, assetId: order.assetId },
      idempotencyKey: `maintenance.closed:${order.id}`,
    },
    transaction
  );
}

function publishCountCompleted(count, transaction) {
  return publishDomainEvent(
    {
      groupId: count.groupId,
      companyId: count.companyId,
      aggregateType: 'InventoryCount',
      aggregateId: count.id,
      eventType: 'inventory.count.completed',
      payload: { id: count.id, locationId: count.locationId },
      idempotencyKey: `inventory.count.completed:${count.id}`,
    },
    transaction
  );
}

function publishLossOpened(lossCase, transaction) {
  return publishDomainEvent(
    {
      groupId: lossCase.groupId,
      companyId: lossCase.companyId,
      aggregateType: 'InventoryLossCase',
      aggregateId: lossCase.id,
      eventType: 'inventory.loss.opened',
      payload: { id: lossCase.id, inventoryItemId: lossCase.inventoryItemId, assetId: lossCase.assetId },
      idempotencyKey: `inventory.loss.opened:${lossCase.id}`,
    },
    transaction
  );
}

module.exports = {
  publishItemCreated,
  publishReceiptCompleted,
  publishRequisitionCreated,
  publishMovementRecorded,
  publishStockLow,
  publishToolLoanCreated,
  publishToolLoanOverdue,
  publishToolReturned,
  publishAssetTransferred,
  publishAssetDisposed,
  publishMaintenanceOpened,
  publishMaintenanceClosed,
  publishCountCompleted,
  publishLossOpened,
};
