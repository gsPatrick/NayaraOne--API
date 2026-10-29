'use strict';

const { publishDomainEvent } = require('../../../engines/events/outbox');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { auditSnapshot } = require('./evaluations.mapper');

/** Evento ai.evaluation.* na MESMA transação (outbox). O payload leva só ids e estado, nunca o conteúdo dos casos. */
async function publishEvaluationEvent(ctx, eventType, ev, transaction) {
  return publishDomainEvent({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    aggregateType: 'AiEvaluation',
    aggregateId: ev.id,
    eventType,
    payload: { evaluationId: ev.id, agentCode: ev.agentCode, agentVersion: ev.agentVersion, suite: ev.suite, status: ev.status, homologatedBy: ev.homologatedBy },
    idempotencyKey: `${eventType}:${ev.id}`,
  }, transaction);
}

async function auditEvaluation(ctx, action, ev, before, reason, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId || null,
    action,
    entityType: 'AiEvaluation',
    entityId: ev.id,
    beforeJson: before ? auditSnapshot(before) : { registro: 'inexistente' },
    afterJson: auditSnapshot(ev),
    reason,
  }, transaction);
}

module.exports = { publishEvaluationEvent, auditEvaluation };
