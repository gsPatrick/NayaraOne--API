'use strict';

// Apoio dos testes do validador factual com banco (M9-D407): conteúdo em rascunho com os fatos REAIS do read model público de um
// imóvel (mais os extras do teste), sem passar pelas regras de criação por tipo. Não é teste.
const fx = require('../../helpers/m9d406Fixtures');
const service = require('../../../src/features/marketing/content/content.service');
const repo = require('../../../src/features/marketing/content/pipeline.repository');
const { newCheck } = require('../../../src/features/marketing/content/pipeline.core');
const { createContentWithProvenance } = require('../../../src/features/marketing/content/contentProvenance');
const { buildFactsFromReadModel } = require('../../../src/features/marketing/content/step.facts');

/** Cria o item em DRAFT com o texto e os fatos do imóvel (+extras) e o passo `facts` gravado. Devolve { itemId, propertyId, facts }. */
async function draftWithFacts(t, tenant, texto, extraFacts = {}) {
  const prop = await fx.seedProperty(t, tenant);
  const real = await buildFactsFromReadModel('property', prop.id, tenant, t);
  const facts = { ...real.facts, ...extraFacts };
  const { item, version } = await createContentWithProvenance({
    type: 'NEW_PROPERTY', title: 'QA-M9 D407', source: { entityType: 'property', entityId: prop.id, version: real.sourceVersion, facts }, bodyJson: { texto },
  }, tenant, tenant.userId, t);
  await repo.writeCheck(version.id, 'facts', newCheck(true, {}, 'qa-m9'), tenant.userId, t);
  return { itemId: item.id, propertyId: prop.id, facts };
}

/** Roda só o passo factual e devolve { status, findings, checks }. */
async function factualResult(t, tenant, texto, extraFacts) {
  const { itemId } = await draftWithFacts(t, tenant, texto, extraFacts);
  await service.runFactualCheck({ tenant, actor: tenant.userId, itemId }, t);
  const content = await service.getContent(tenant, itemId, t);
  return { status: content.status, findings: content.findings, checks: content.checks, itemId };
}

module.exports = { draftWithFacts, factualResult };
