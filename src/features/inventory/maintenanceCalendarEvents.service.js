'use strict';

const { Asset } = require('../../models');
const { publishSourceEvent } = require('../core-governance/calendar/calendar.publisher');

/** Eventos da ordem de manutenção para o Calendário unificado (M9-D802 §3.1.1): data agendada da ordem. Na transação da operação. */
async function payloadOf(order, transaction) {
  const asset = await Asset.findOne({ where: { id: order.assetId, companyId: order.companyId }, transaction });
  return {
    assetId: order.assetId, assetName: asset ? asset.name : null, scheduledAt: order.scheduledAt || order.openedAt,
    description: order.description || null, status: order.status, responsibleUserId: order.updatedBy || order.createdBy || null,
  };
}

/** Abertura (agendamento) ou reagendamento da ordem. */
async function publishMaintenanceScheduled(order, rescheduled, transaction) {
  return publishSourceEvent({
    entity: order, aggregateType: 'InventoryMaintenanceOrder', eventType: rescheduled ? 'maintenance.order.rescheduled' : 'maintenance.order.scheduled',
    payload: await payloadOf(order, transaction),
  }, transaction);
}

/** Ordem fechada (manutenção concluída). */
async function publishMaintenanceCompleted(order, transaction) {
  return publishSourceEvent({
    entity: order, aggregateType: 'InventoryMaintenanceOrder', eventType: 'maintenance.order.completed', payload: await payloadOf(order, transaction), version: 'closed',
  }, transaction);
}

module.exports = { publishMaintenanceScheduled, publishMaintenanceCompleted };
