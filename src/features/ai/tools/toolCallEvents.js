'use strict';

const { publishToolCallBlocked } = require('../events');
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

/** Evento do livro (ai.tool_call.blocked) no outbox, na mesma transação (events/, M9-D029): só ids, nome da tool e o código do motivo. */
async function publishToolCallEvent(ctx, type, call, extra, transaction) {
  return publishToolCallBlocked(ctx, { toolCallId: call.id, runId: call.runId, toolName: call.toolName, reason: call.blockedReason }, transaction);
}

module.exports = { auditToolCall, publishToolCallEvent };
