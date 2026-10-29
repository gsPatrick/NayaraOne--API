'use strict';

const { publishDomainEvent } = require('../../../engines/events/outbox');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { auditSnapshot } = require('./toolCalls.mapper');

/** Trilha antes/depois da chamada (sem argumentos nem resultado), na MESMA transação da operação. */
async function auditToolCall(ctx, action, call, before, reason, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId || null,
    action,
    entityType: 'AiToolCall',
    entityId: call.id,
    beforeJson: before ? auditSnapshot(before) : { registro: 'inexistente' },
    afterJson: { ...auditSnapshot(call), correlationId: ctx.correlationId || null },
    reason,
  }, transaction);
}

/** Evento do livro (ai.tool_call.blocked) no outbox, na mesma transação. O payload é montado aqui: nunca leva argumento nem resultado. */
async function publishToolCallEvent(ctx, type, call, extra, transaction) {
  return publishDomainEvent({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    aggregateType: 'AiToolCall',
    aggregateId: call.id,
    eventType: type,
    payload: {
      toolCallId: call.id, runId: call.runId, seq: call.seq, toolName: call.toolName, status: call.status,
      blockedReason: call.blockedReason, capability: (extra && extra.capability) || null, correlationId: (extra && extra.correlationId) || null,
    },
    idempotencyKey: `${type}:${call.id}`,
  }, transaction);
}

module.exports = { auditToolCall, publishToolCallEvent };
