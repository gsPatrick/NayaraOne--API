'use strict';

const { publishSourceEvent } = require('../core-governance/calendar/calendar.publisher');

/** Eventos do cronograma de cobrança para o Calendário unificado (M9-D802 §3.1.1): vencimento da competência. Na transação da operação. */
function payloadOf(schedule) {
  return { contractId: schedule.contractId, period: schedule.period, dueDate: schedule.dueDate, status: schedule.status, responsibleUserId: null };
}

function publishScheduleUpserted(schedule, transaction) {
  return publishSourceEvent({ entity: schedule, aggregateType: 'BillingSchedule', eventType: 'billing.schedule_item.upserted', payload: payloadOf(schedule) }, transaction);
}

/** Competência totalmente quitada: fecha o item. */
function publishSchedulePaid(schedule, transaction) {
  return publishSourceEvent({ entity: schedule, aggregateType: 'BillingSchedule', eventType: 'billing.schedule_item.paid', payload: payloadOf(schedule) }, transaction);
}

module.exports = { publishScheduleUpserted, publishSchedulePaid };
