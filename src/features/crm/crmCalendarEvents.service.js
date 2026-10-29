'use strict';

const { publishSourceEvent } = require('../core-governance/calendar/calendar.publisher');

/** Eventos de tarefa e visita do CRM que alimentam o Calendário unificado (M9-D802 §3.1.1). Sempre na transação da operação. */
const TASK_CLOSED = ['DONE', 'CANCELED'];

function taskPayload(task) {
  return { title: task.title, dueAt: task.dueAt || null, assignedToUserId: task.assignedToUserId || null, status: task.status, opportunityId: task.relatedEntityId || null };
}

/** `before` é o status anterior (null na criação). Escolhe o evento: created, completed, cancelled, reopened ou updated. */
function publishTaskChange(task, before, transaction) {
  let eventType = 'crm.task.updated';
  if (before === null) eventType = 'crm.task.created';
  else if (task.status === 'DONE' && before !== 'DONE') eventType = 'crm.task.completed';
  else if (task.status === 'CANCELED' && before !== 'CANCELED') eventType = 'crm.task.cancelled';
  else if (TASK_CLOSED.includes(before) && !TASK_CLOSED.includes(task.status)) eventType = 'crm.task.reopened';
  return publishSourceEvent({ entity: task, aggregateType: 'Task', eventType, payload: taskPayload(task) }, transaction);
}

function visitPayload(visit, propertyTitle) {
  return { scheduledAt: visit.scheduledAt, agentUserId: visit.agentUserId || null, status: visit.status, propertyId: visit.propertyId, propertyTitle: propertyTitle || null };
}

/** Agendamento (criação ou volta ao status SCHEDULED) e reagendamento. */
function publishVisitScheduled(visit, propertyTitle, rescheduled, transaction) {
  return publishSourceEvent({
    entity: visit, aggregateType: 'Visit', eventType: rescheduled ? 'crm.visit.rescheduled' : 'crm.visit.scheduled', payload: visitPayload(visit, propertyTitle),
  }, transaction);
}

/** Cancelamento (CANCELED, NO_SHOW ou exclusão): fecha o item sem concluir. Chave por visita e instante da mudança. */
function publishVisitCancelled(visit, propertyTitle, transaction) {
  return publishSourceEvent({ entity: visit, aggregateType: 'Visit', eventType: 'crm.visit.cancelled', payload: visitPayload(visit, propertyTitle) }, transaction);
}

module.exports = { publishTaskChange, publishVisitScheduled, publishVisitCancelled, visitPayload };
