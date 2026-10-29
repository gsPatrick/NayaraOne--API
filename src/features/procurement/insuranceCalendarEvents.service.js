'use strict';

const { publishSourceEvent } = require('../core-governance/calendar/calendar.publisher');

/** Eventos da tarefa de renovação de apólice para o Calendário unificado (M9-D802 §3.1.1). Na transação da operação. */
function payloadOf(task, policy) {
  return {
    policyId: task.policyId,
    policyNumber: (policy && (policy.externalPolicyNumber || policy.id)) || task.policyId,
    dueDate: task.dueDate,
    assignedToUserId: task.assignedToUserId || (policy && policy.createdBy) || null,
    status: task.status,
  };
}

const publish = (eventType, task, policy, transaction) => publishSourceEvent({
  entity: task, aggregateType: 'InsuranceRenewalTask', eventType, payload: payloadOf(task, policy), version: eventType === 'insurance.renewal_task.upserted' ? task.updatedAt && new Date(task.updatedAt).getTime() : 'closed',
}, transaction);

const publishRenewalUpserted = (task, policy, transaction) => publish('insurance.renewal_task.upserted', task, policy, transaction);
const publishRenewalCompleted = (task, policy, transaction) => publish('insurance.renewal_task.completed', task, policy, transaction);
const publishRenewalCancelled = (task, policy, transaction) => publish('insurance.renewal_task.cancelled', task, policy, transaction);

module.exports = { publishRenewalUpserted, publishRenewalCompleted, publishRenewalCancelled };
