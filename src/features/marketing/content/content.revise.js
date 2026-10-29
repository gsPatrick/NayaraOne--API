'use strict';

const repo = require('./pipeline.repository');
const { sha256, canonicalJson } = require('./sourceStamp');
const { assertTransition } = require('./pipeline.states');
const { buildFactsFromReadModel, generateDraftWithNay } = require('./step.facts');
const { newCheck } = require('./pipeline.core');
const { contentInvalid } = require('./pipeline.errors');
const { normalizeGeneration } = require('./contentProvenance');

const REVISABLE = Object.freeze(['DRAFT', 'FACT_CHECK_FAILED']);

/** Contexto da marca para a NAY: só código e tokens do template (sem dado pessoal). */
async function brandContextOf(input, transaction) {
  if (!input.templateId && !input.templateCode) return {};
  const template = await repo.findPublishedTemplate({ templateId: input.templateId, code: input.templateCode }, transaction);
  return template ? { templateCode: template.code, brandTokens: template.brand_tokens_json || {} } : {};
}

/** Texto novo: o informado (redação manual) ou o da NAY com os fatos ATUAIS; NAY fora do ar devolve nayError e deixa o texto vazio. */
async function draftText({ input, facts, type, transaction }) {
  if (input.texto !== undefined) return { text: input.texto.trim(), generation: null };
  try {
    const out = await generateDraftWithNay(facts, type, await brandContextOf(input, transaction));
    return { text: out.text, generation: { modelName: out.modelName, nayRunId: out.nayRunId } };
  } catch (err) {
    if (err.code !== 'MKT_NAY_UNAVAILABLE') throw err;
    return { text: '', generation: null, nayError: err };
  }
}

/**
 * Revisão (nova versão em DRAFT): item DRAFT ou FACT_CHECK_FAILED recebe o texto novo (manual) ou o da NAY com os fatos de agora.
 * Mesmo texto e mesmos fatos da versão corrente não duplicam versão. FACT_CHECK_FAILED -> DRAFT (nova versão).
 */
async function reviseDraft({ tenant, actor, item, version, input }, transaction) {
  if (!REVISABLE.includes(item.status)) throw contentInvalid('Só é possível revisar conteúdo em rascunho ou com validação reprovada.', { status: item.status });
  const source = item.source_entity_type ? await buildFactsFromReadModel(item.source_entity_type, item.source_entity_id, tenant, transaction, item.type) : null;
  const facts = source ? source.facts : (version.facts_snapshot_json || {});
  const drafted = await draftText({ input, facts, type: item.type, transaction });
  if (drafted.nayError && input.texto === undefined && !item.source_entity_type) throw drafted.nayError;
  const body = { texto: drafted.text, ...(drafted.nayError ? { erro: 'MKT_NAY_UNAVAILABLE' } : {}) };
  const generation = drafted.generation ? normalizeGeneration(drafted.generation) : { modelName: null, nayRunId: null };
  const contentHash = sha256(canonicalJson({ body, facts }));
  if (item.status === 'DRAFT' && contentHash === version.content_hash) return { version, created: false, nayError: drafted.nayError };

  const checks = { facts: newCheck(true, source ? { sourceVersion: source.sourceVersion, factsHash: source.factsHash } : { semFonte: true }, null) };
  const created = await repo.insertNextVersion(tenant, actor, version, {
    body, facts, factsHash: source ? source.factsHash : version.facts_hash, modelName: generation.modelName, nayRunId: generation.nayRunId,
    checks, contentHash,
  }, transaction);
  if (source) await repo.setSource(item.id, source.sourceVersion, actor, transaction);
  if (item.status !== 'DRAFT') {
    assertTransition(item.status, 'DRAFT');
    await repo.setStatus(item.id, 'DRAFT', actor, transaction);
  }
  return { version: created, created: true, nayError: drafted.nayError };
}

module.exports = { reviseDraft, draftText, brandContextOf, REVISABLE };
