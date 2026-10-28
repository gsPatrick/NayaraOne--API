'use strict';

const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { loadItemWithFacts } = require('./currentSource');

/**
 * M9-D405 regra 5 — só quando a ATUALIZAÇÃO chega a PUBLISHED o item antigo vai a ARCHIVED (transição PUBLISHED -> ARCHIVED da
 * M9-D406, única forma de arquivar um publicado). Antes disso o antigo continua PUBLISHED. Idempotente. A M9-D406 chama esta função
 * ao concluir a publicação de qualquer item.
 */
async function archiveSupersededOnPublish(updateItemId, tenant, actorUserId, transaction) {
  const update = await loadItemWithFacts(updateItemId, tenant, transaction, { lock: true });
  if (!update || update.status !== 'PUBLISHED' || !update.updates_content_item_id) return { archived: false };

  const old = await loadItemWithFacts(update.updates_content_item_id, tenant, transaction, { lock: true });
  if (!old || old.status !== 'PUBLISHED') return { archived: false };

  await sequelize.query(
    'UPDATE marketing.content_items SET status = \'ARCHIVED\', superseded_by = :newId, updated_by = :actor, updated_at = now() WHERE id = :id AND company_id = :companyId',
    { replacements: { newId: update.id, id: old.id, companyId: tenant.companyId, actor: actorUserId || null }, transaction }
  );
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'marketing.content.superseded_archived',
    entityType: 'MarketingContentItem', entityId: old.id, beforeJson: { status: 'PUBLISHED', supersededBy: old.superseded_by },
    afterJson: { status: 'ARCHIVED', supersededBy: update.id }, reason: 'A atualização foi publicada; o conteúdo anterior foi arquivado.',
  }, transaction);
  return { archived: true, archivedItemId: old.id };
}

module.exports = { archiveSupersededOnPublish };
