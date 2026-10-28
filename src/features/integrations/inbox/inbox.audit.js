'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { AUDIT_ACTION, ENTITY_TYPE } = require('./inbox.constants');

/** Visão do evento para a auditoria: estado e contadores, nunca o corpo nem cabeçalho. */
const visao = (r) => ({
  status: r.status, attempts: r.attempts, nextAttemptAt: r.nextAttemptAt ? new Date(r.nextAttemptAt).toISOString() : null,
  deadLetterReason: r.deadLetterReason || null, providerCode: r.providerCode, externalEventId: r.externalEventId,
});

async function auditarMudanca(ctx, antes, depois, motivo, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null,
    action: AUDIT_ACTION, entityType: ENTITY_TYPE, entityId: depois.id,
    beforeJson: antes, afterJson: visao(depois), reason: motivo,
  }, transaction);
}

module.exports = { auditarMudanca, visao };
