'use strict';

const { Asset, InventoryMaintenanceOrder } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

// Guia do Marcelo §8/item 7: devolução danificada abre manutenção; OS fecha manualmente e
// libera o asset de volta para AVAILABLE.
async function openMaintenanceOrder(payload, actorUserId, transaction) {
  const { groupId, companyId, assetId, sourceToolLoanId, description } = payload;
  if (!groupId || !companyId || !assetId) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "assetId" são obrigatórios.', 'MAINTENANCE_VALIDATION');
  }
  const order = await InventoryMaintenanceOrder.create(
    {
      groupId,
      companyId,
      assetId,
      sourceToolLoanId: sourceToolLoanId || null,
      description: description || null,
      status: 'OPEN',
      openedAt: new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'MAINTENANCE_ORDER_OPENED', entityType: 'InventoryMaintenanceOrder', entityId: order.id, reason: 'Ordem de manutenção aberta.' },
    transaction
  );

  return order;
}

async function listMaintenanceOrders(transaction, { status, assetId } = {}) {
  const where = {};
  if (status) where.status = status;
  if (assetId) where.assetId = assetId;
  return InventoryMaintenanceOrder.findAll({ where, order: [['opened_at', 'DESC']], transaction });
}

async function closeMaintenanceOrder(orderId, actorUserId, transaction) {
  const order = await InventoryMaintenanceOrder.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!order) throw AppError.notFound('Ordem de manutenção não encontrada.', 'MAINTENANCE_NOT_FOUND');
  if (order.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível fechar uma OS em OPEN (atual: ${order.status}).`, 'MAINTENANCE_INVALID_TRANSITION');
  }

  const asset = await Asset.findByPk(order.assetId, { transaction, lock: transaction.LOCK.UPDATE });
  if (asset && asset.status === 'MAINTENANCE') {
    asset.status = 'AVAILABLE';
    asset.updatedBy = actorUserId || null;
    await asset.save({ transaction });
  }

  order.status = 'CLOSED';
  order.closedAt = new Date();
  order.updatedBy = actorUserId || null;
  await order.save({ transaction });

  await registrarAuditoria(
    { groupId: order.groupId, companyId: order.companyId, actorUserId, action: 'MAINTENANCE_ORDER_CLOSED', entityType: 'InventoryMaintenanceOrder', entityId: order.id, reason: 'Ordem de manutenção fechada — patrimônio liberado.' },
    transaction
  );

  return order;
}

module.exports = { openMaintenanceOrder, listMaintenanceOrders, closeMaintenanceOrder };
