'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const repo = require('./pipeline.repository');
const { assertTransition } = require('./pipeline.states');
const { loadLocked } = require('./pipeline.core');

/**
 * Executor genérico das transições da tabela de estados (M9-D406), usado por quem não tem executor próprio (ex.: o worker de
 * publicação, M9-D411, e o cancelamento humano de jobs, M9-D410). Trava o item, recusa par fora da tabela (409) e audita.
 */
async function changeStatus({ tenant, actor, itemId, to, reason }, transaction) {
  const { item } = await loadLocked(itemId, transaction);
  assertTransition(item.status, to);
  await repo.setStatus(item.id, to, actor, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor, action: 'marketing.content.status_changed',
    entityType: 'MarketingContentItem', entityId: item.id, beforeJson: { status: item.status }, afterJson: { status: to },
    reason: reason || `Status ${item.status} -> ${to}.`,
  }, transaction);
  return { itemId: item.id, from: item.status, status: to };
}

module.exports = { changeStatus };
