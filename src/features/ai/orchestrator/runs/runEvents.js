'use strict';

const { publishDomainEvent } = require('../../../../engines/events/outbox');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { EVENT_BY_STATUS } = require('./runs.constants');
const { auditSnapshot } = require('./runs.mapper');

/** Evento do livro (ai.run.completed / ai.run.failed) na MESMA transação do run (outbox). Outros estados não emitem (D029). */
async function publishRunEvent(ctx, run, transaction) {
  const eventType = EVENT_BY_STATUS[run.status];
  if (!eventType) return null;
  return publishDomainEvent({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    aggregateType: 'AiRun',
    aggregateId: run.id,
    eventType,
    payload: {
      runId: run.id, agentCode: run.agentCode, agentVersion: run.agentVersion, status: run.status, routingPath: run.routingPath,
      providerCode: run.providerCode, modelCode: run.modelCode, tokensIn: run.tokensIn, tokensOut: run.tokensOut,
      costAmount: run.costAmount, errorCode: run.errorCode, finishedAt: run.finishedAt,
    },
    idempotencyKey: `${eventType}:${run.id}`,
  }, transaction);
}

/** Trilha antes/depois do run (sem texto de entrada/saída). Mesma transação da operação. */
async function auditRun(ctx, action, run, before, reason, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId || null,
    action,
    entityType: 'AiRun',
    entityId: run.id,
    beforeJson: before ? auditSnapshot(before) : { registro: 'inexistente' },
    afterJson: auditSnapshot(run),
    reason,
  }, transaction);
}

module.exports = { publishRunEvent, auditRun };
