'use strict';

const { publishDomainEvent } = require('../../../../engines/events/outbox');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');

const snapshot = (c) => (c ? { id: c.id, agentCode: c.agentCode, caseKey: c.caseKey, category: c.category, version: c.version, status: c.status } : { registro: 'inexistente' });

/** Auditoria (antes e depois, sem o conteúdo do caso) e evento ai.golden_case.* na MESMA transação (outbox). */
async function recordChange(ctx, { action, eventType, before, after, reason }, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action, entityType: 'AiGoldenCase', entityId: after.id,
    beforeJson: snapshot(before), afterJson: snapshot(after), reason,
  }, transaction);
  await publishDomainEvent({
    groupId: ctx.groupId, companyId: ctx.companyId, aggregateType: 'AiGoldenCase', aggregateId: after.id, eventType,
    payload: { goldenCaseId: after.id, agentCode: after.agentCode, caseKey: after.caseKey, category: after.category, version: after.version, status: after.status },
    idempotencyKey: `${eventType}:${after.id}`,
  }, transaction);
}

module.exports = { recordChange };
