'use strict';

const { publishRunEvent } = require('../../events');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { auditSnapshot } = require('./runs.mapper');

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

// ai.run.completed / ai.run.failed (COMPLETED, FAILED e BLOCKED) saem de events/ (M9-D029), na mesma transação do run.
module.exports = { publishRunEvent, auditRun };
