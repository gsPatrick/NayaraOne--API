'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { auditSnapshot } = require('./memory.mapper');

/** Trilha antes/depois (campos de controle, sem o valor), com o run quando houver. Mesma transação da operação. */
async function auditMemory(ctx, action, memory, before, reason, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    actorUserId: ctx.serviceIdentity ? null : ctx.userId || null,
    action,
    entityType: 'AiMemory',
    entityId: memory.id,
    beforeJson: before ? auditSnapshot(before) : { registro: 'inexistente' },
    afterJson: { ...auditSnapshot(memory), ...(ctx.runId ? { runId: ctx.runId } : {}) },
    reason,
  }, transaction);
}

module.exports = { auditMemory };
