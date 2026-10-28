'use strict';

const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { createContentWithProvenance } = require('./contentProvenance');

/**
 * M9-D405 regras 4 e 5 (conteúdo publicado) — cria o item de ATUALIZAÇÃO: mesmo `type` do original, DRAFT, com os fatos novos e
 * `updates_content_item_id` apontando para o antigo; o antigo recebe `superseded_by` e continua PUBLISHED (nunca se apaga nem se
 * reescreve publicação). O texto novo é gerado depois (M9-D406); o corpo da versão 1 só marca "aguardando geração".
 * Quem chama já travou o item antigo (FOR UPDATE), o que serializa dois eventos iguais.
 */
async function createUpdateItem(oldItem, current, tenant, actorUserId, transaction) {
  const source = { entityType: oldItem.source_entity_type, entityId: oldItem.source_entity_id, version: current.version, facts: current.facts };
  const { item, version } = await createContentWithProvenance({
    type: oldItem.type,
    title: oldItem.title,
    source,
    bodyJson: { aguardandoGeracao: true, atualizaConteudoId: oldItem.id },
    extra: {
      updatesContentItemId: oldItem.id,
      campaignId: oldItem.campaign_id,
      autopublishClass: oldItem.autopublish_class,
      templateId: oldItem.version_template_id,
      templateVersionNo: oldItem.version_template_version_no,
    },
  }, tenant, actorUserId, transaction);

  await sequelize.query(
    'UPDATE marketing.content_items SET superseded_by = :newId, updated_by = :actor, updated_at = now() WHERE id = :id AND company_id = :companyId',
    { replacements: { newId: item.id, id: oldItem.id, companyId: tenant.companyId, actor: actorUserId || null }, transaction }
  );
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'marketing.content.source_update_created',
    entityType: 'MarketingContentItem', entityId: item.id,
    beforeJson: { contentItemId: oldItem.id, status: oldItem.status, sourceVersion: oldItem.source_version, supersededBy: null },
    afterJson: { contentItemId: item.id, status: item.status, sourceVersion: current.version, updatesContentItemId: oldItem.id, factsHash: version.factsHash },
    reason: 'Os dados do imóvel mudaram depois da publicação; foi criada uma atualização, e o histórico foi mantido.',
  }, transaction);
  return { itemId: item.id, versionId: version.id };
}

module.exports = { createUpdateItem };
