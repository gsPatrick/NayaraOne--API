'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { auditSnapshot } = require('./agents.mapper');

/** Trilha antes/depois de cada mudança de agente (sem o texto da política, só o hash). Mesma transação da operação. */
async function auditAgent(ctx, action, agent, before, reason, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId || null,
    action,
    entityType: 'AiAgent',
    entityId: agent.id,
    beforeJson: before ? auditSnapshot(before) : { registro: 'inexistente' },
    afterJson: auditSnapshot(agent),
    reason,
  }, transaction);
}

module.exports = { auditAgent };
