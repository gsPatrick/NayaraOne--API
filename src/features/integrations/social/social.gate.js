'use strict';

const { assertPropertyPublishable } = require('../publication');
const { assertSourceFresh } = require('../../marketing/content/sourceStale');
const { loadContent, expectedApprovedHash } = require('./social.content');
const { isKillSwitchActive } = require('./social.killswitch');
const { readSocialParams } = require('./social.params');
const errors = require('./social.errors');

const PUBLISHABLE_STATUSES = Object.freeze(['APPROVED', 'SCHEDULED', 'PUBLISHING']);
const SYSTEM_APPROVER = 'SYSTEM_AUTOPUBLISH:';
const bySystem = (v) => typeof v.approved_by === 'string' && v.approved_by.startsWith(SYSTEM_APPROVER);

/**
 * A porta da publicação em rede social (M9-D239 3.2 itens 1 e 5). Devolve o conteúdo e sua versão aprovada ou recusa, nesta ordem:
 *  1. conteúdo inexistente: 404; kill switch do Marketing ligado: 403 (sobrepõe tudo);
 *  2. modo AUTO (ninguém mandou publicar): o parâmetro `integration.social.auto_publish_enabled` precisa estar ligado, senão 403
 *     INTEGRATION_SOCIAL_AUTO_PUBLISH_DISABLED;
 *  3. só sai conteúdo APPROVED (ou já agendado) com aprovação gravada na versão corrente; senão 403 INTEGRATION_SOCIAL_CONTENT_NOT_APPROVED.
 *     Conteúdo gerado pela NAY nasce DRAFT e só sai com aprovação HUMANA; a aprovação por regra pré-aprovada (SYSTEM_AUTOPUBLISH, a classe
 *     autopublicável auditada) só vale no modo AUTO e com a classe registrada no item;
 *  4. o hash da versão aprovada precisa coincidir com o recalculado (conteúdo ou template editado depois da aprovação): 409
 *     INTEGRATION_SOCIAL_CONTENT_CHANGED_AFTER_APPROVAL;
 *  5. a fonte do conteúdo não pode ter mudado e imóvel só sai se continua no read model público.
 * Não grava nada: a invalidação da aprovação (voltar a PENDING_APPROVAL) é do Marketing (M9-D404/D406).
 */
async function assertPublishable(ctx, { itemId, mode = 'MANUAL' }, transaction, { lock = false } = {}) {
  const content = await loadContent(ctx.companyId, itemId, transaction, { lock });
  if (!content) throw errors.contentNotFound();
  if (await isKillSwitchActive({ companyId: ctx.companyId, campaignId: content.campaign_id, transaction })) throw errors.killSwitchActive();
  const params = await readSocialParams(ctx, transaction);
  if (mode === 'AUTO' && !params.autoPublishEnabled) throw errors.autoPublishDisabled();
  const aprovado = PUBLISHABLE_STATUSES.includes(content.status) && content.version_id && content.approved_hash && content.approved_by;
  const porRegra = bySystem(content);
  const regraValida = porRegra && mode === 'AUTO' && Boolean(content.autopublish_class);
  if (!aprovado || (porRegra && !regraValida)) {
    throw errors.contentNotApproved({ contentItemId: itemId, status: content.status });
  }
  if (content.approved_hash !== await expectedApprovedHash(content, transaction)) {
    throw errors.changedAfterApproval({ contentItemId: itemId, versionId: content.version_id });
  }
  await assertSourceFresh(itemId, ctx, transaction);
  if (content.source_entity_type === 'property') await assertPropertyPublishable(ctx, content.source_entity_id, transaction);
  return content;
}

module.exports = { assertPublishable, PUBLISHABLE_STATUSES };
