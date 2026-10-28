'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { AUDIT_ACTION, ENTITY_TYPE } = require('./sync.constants');

/** Visão do cursor para a trilha de auditoria (sem nada além do ponteiro e do estado). */
const visao = (c) => (c ? {
  stream: c.stream, status: c.status, cursorValue: c.cursorValue, cursorKind: c.cursorKind, consecutiveFailures: c.consecutiveFailures,
  leaseOwner: c.leaseOwner, lastErrorCode: c.lastErrorCode, itemsSyncedTotal: String(c.itemsSyncedTotal ?? 0),
} : { registro: 'Não existia (cursor criado neste ciclo)' });

async function auditarCursor(ctx, antes, depois, motivo, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId || null,
    action: AUDIT_ACTION,
    entityType: ENTITY_TYPE,
    entityId: depois.id,
    beforeJson: antes || visao(null),
    afterJson: visao(depois),
    reason: motivo,
  }, transaction);
}

module.exports = { auditarCursor, visao };
