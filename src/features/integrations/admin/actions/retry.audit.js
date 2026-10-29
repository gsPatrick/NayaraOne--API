'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');

/**
 * Auditoria `integration.error.retry_requested` (M9-D250 3.1 item 6): antes e depois do erro, o motivo informado e quem aprovou. Em operação perigosa o aprovador é
 * quem confirmou com MFA recente; nunca grava conteúdo do envio nem segredo.
 */
async function auditRetryRequested(ctx, error, target, { reason, dangerous, confirmDangerous }, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action: 'integration.error.retry_requested', entityType: 'IntegrationError', entityId: error.id,
    beforeJson: { status: 'OPEN', source: error.source, errorCode: error.errorCode },
    afterJson: {
      status: 'RETRYING', source: error.source, errorCode: error.errorCode, target, dangerous, confirmDangerous, approvedBy: dangerous ? ctx.userId || null : null, requestedBy: ctx.userId || null,
    },
    reason: `Retry solicitado. Motivo: ${reason}`,
  }, transaction);
}

module.exports = { auditRetryRequested };
