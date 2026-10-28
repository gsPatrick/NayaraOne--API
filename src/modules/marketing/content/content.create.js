'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishMarketingEvent } = require('../marketing.events');
const { createContentWithProvenance } = require('./contentProvenance');
const { sha256 } = require('./sourceStamp');
const { buildFactsFromReadModel } = require('./step.facts');
const { draftText } = require('./content.revise');
const { newCheck } = require('./pipeline.core');
const repo = require('./pipeline.repository');

const ENTITY = 'MarketingContentItem';

function titleOf(input, facts) {
  if (input.title) return input.title;
  return String(facts.titulo || facts.nomeEmpreendimento || [facts.tipo, facts.bairro].filter(Boolean).join(' em ') || 'Conteúdo').slice(0, 300);
}

/**
 * Cria o item e a versão 1: fatos do read model público (função 1), rascunho da NAY com SÓ os fatos (função 2) ou o texto
 * escrito à mão. NAY indisponível NÃO impede a criação: o item fica DRAFT com texto vazio e `nayError` (o chamador responde 503
 * depois do commit). Grava checks_json.facts, a auditoria e o evento marketing.content.created.
 */
async function createContent({ tenant, actor, input }, transaction) {
  const source = input.sourceEntityType ? await buildFactsFromReadModel(input.sourceEntityType, input.sourceEntityId, tenant, transaction) : null;
  const facts = source ? source.facts : {};
  const drafted = await draftText({ input, facts, type: input.type, transaction });
  const body = { texto: drafted.text, ...(drafted.nayError ? { erro: 'MKT_NAY_UNAVAILABLE' } : {}) };
  const { item, version } = await createContentWithProvenance({
    type: input.type,
    title: titleOf(input, facts),
    source: source ? { entityType: input.sourceEntityType, entityId: input.sourceEntityId, version: source.sourceVersion, facts } : null,
    bodyJson: body,
    generation: drafted.generation,
    extra: { campaignId: input.campaignId },
  }, tenant, actor, transaction);

  const check = newCheck(true, source ? { sourceVersion: source.sourceVersion, factsHash: source.factsHash } : { semFonte: true }, sha256(version.id));
  await repo.writeCheck(version.id, 'facts', check, actor, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor, action: 'marketing.content.create', entityType: ENTITY, entityId: item.id,
    beforeJson: null, afterJson: { status: 'DRAFT', type: item.type, versionNo: version.version_no, source: input.sourceEntityType || null, byNay: Boolean(drafted.generation) },
    reason: 'Conteúdo de Marketing criado em rascunho.',
  }, transaction);
  await publishMarketingEvent({
    type: 'marketing.content.created', tenant,
    payload: {
      contentId: item.id, type: item.type, versionNo: version.version_no, createdBy: actor,
      sourceEntity: input.sourceEntityType ? { type: input.sourceEntityType, id: input.sourceEntityId } : 'none',
    },
  }, transaction);
  return { itemId: item.id, versionId: version.id, nayError: drafted.nayError || null };
}

module.exports = { createContent };
