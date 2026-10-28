'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');

/** Auditoria do cofre (M9-D202): só ids, finalidade e versões. Nunca o valor, nunca a referência. */
async function auditarSegredo(ctx, action, connection, afterJson, reason, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null,
    action, entityType: 'IntegrationConnection', entityId: connection.id, beforeJson: null,
    afterJson: { connectionId: connection.id, ...afterJson }, reason,
  }, transaction);
}

module.exports = { auditarSegredo };
