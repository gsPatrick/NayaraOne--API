'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { auditSnapshot } = require('./ingestion.mapper');

/** Trilha antes/depois da ingestão (estado e contagens, sem texto do documento), com o run quando houver. Mesma transação da operação. */
async function auditIngestion(ctx, action, ingestion, before, reason, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    actorUserId: ctx.serviceIdentity || !ctx.userId ? null : ctx.userId,
    action,
    entityType: 'AiIngestion',
    entityId: ingestion.id,
    beforeJson: before ? auditSnapshot(before) : { registro: 'inexistente' },
    afterJson: { ...auditSnapshot(ingestion), ...(ctx.runId ? { runId: ctx.runId } : {}), ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}) },
    reason,
  }, transaction);
}

module.exports = { auditIngestion };
