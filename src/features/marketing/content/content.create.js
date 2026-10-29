'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishMarketingEvent } = require('../marketing.events');
const { createContentWithProvenance } = require('./contentProvenance');
const { sha256 } = require('./sourceStamp');
const { getDefinition, assertCreatable } = require('./types/validate');
const { loadTypeSource } = require('./types/source');
const { draftFactsFor } = require('./types/texts');
const { readPercentDecimals } = require('./types/settings');
const { draftText } = require('./content.revise');
const { newCheck } = require('./pipeline.core');
const repo = require('./pipeline.repository');

const ENTITY = 'MarketingContentItem';

function titleOf(input, facts) {
  if (input.title) return input.title;
  return String(facts.titulo || facts.nomeEmpreendimento || input.tema || [facts.tipo, facts.bairro].filter(Boolean).join(' em ') || 'Conteúdo').slice(0, 300);
}

/** Campos próprios de alguns tipos que viajam no corpo da versão (tema e fontes do blog, mídia do vídeo). */
const bodyExtras = (input) => ({
  ...(input.tema ? { tema: input.tema } : {}),
  ...(Array.isArray(input.fontes) ? { fontes: input.fontes } : {}),
  ...(input.midiaId ? { midiaId: input.midiaId } : {}),
});

/**
 * Cria o item e a versão 1: o tipo (M9-D409) escolhe a fonte e os campos mínimos, e tipo, campo ou canal inválido para aqui; fatos
 * do read model público (função 1), rascunho da NAY com SÓ os fatos (função 2) ou o texto escrito à mão. NAY indisponível NÃO impede a criação: o item fica DRAFT com texto vazio e `nayError` (o chamador responde 503
 * depois do commit). Grava checks_json.facts, a auditoria e o evento marketing.content.created.
 */
async function createContent({ tenant, actor, input }, transaction) {
  const def = getDefinition(input.type);
  const source = await loadTypeSource(def, input, tenant, transaction);
  const facts = source ? source.facts : {};
  const decimals = await readPercentDecimals(tenant, transaction);
  await assertCreatable(def, input, facts, { tenant, transaction, decimals });
  const drafted = await draftText({ input, facts: draftFactsFor(def.type, input, facts, decimals), type: input.type, transaction });
  const body = { texto: drafted.text, ...bodyExtras(input), ...(drafted.nayError ? { erro: 'MKT_NAY_UNAVAILABLE' } : {}) };
  const { item, version } = await createContentWithProvenance({
    type: input.type,
    title: titleOf(input, facts),
    source: source ? { entityType: input.sourceEntityType, entityId: input.sourceEntityId, version: source.sourceVersion, facts } : null,
    bodyJson: body,
    generation: drafted.generation,
    extra: { campaignId: input.campaignId, triggerEventId: input.triggerEventId },
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
