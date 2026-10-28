'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { auditSnapshot } = require('./knowledge.mapper');

/** Trilha antes/depois de cada mudança de conhecimento (sem o conteúdo, só o hash). Mesma transação da operação. */
async function auditKnowledge(ctx, action, entry, before, reason, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId || null,
    action,
    entityType: 'AiKnowledgeEntry',
    entityId: entry.id,
    beforeJson: before ? auditSnapshot(before) : { registro: 'inexistente' },
    afterJson: auditSnapshot(entry),
    reason,
  }, transaction);
}

module.exports = { auditKnowledge };
