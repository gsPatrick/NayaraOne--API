'use strict';

const { loadCurrentSource } = require('./currentSource');
const { hashFacts } = require('./sourceStamp');
const nay = require('./pipeline.nayPort');
const { contentInvalid } = require('./pipeline.errors');

/**
 * M9-D406 funções 1 e 2 — fatos e rascunho.
 * buildFactsFromReadModel lê SOMENTE o PublicPropertyReadModel (M9-D403, via currentSource) e devolve { facts, factsHash, sourceVersion }.
 */
async function buildFactsFromReadModel(sourceType, sourceId, tenant, transaction) {
  if (!sourceType || !sourceId) return { facts: {}, factsHash: null, sourceVersion: null };
  const current = await loadCurrentSource(sourceType, sourceId, tenant, transaction);
  if (!current) throw contentInvalid('Tipo de fonte não suportado para conteúdo.', { sourceType });
  return { facts: current.facts, factsHash: hashFacts(current.facts), sourceVersion: current.version };
}

/**
 * generateDraftWithNay chama o agente NAY de conteúdo passando APENAS os fatos (e o contexto da marca, sem dado pessoal). Recebe o
 * texto e o id da execução. Provider indisponível: 503 MKT_NAY_UNAVAILABLE e o conteúdo continua DRAFT (redação manual).
 */
async function generateDraftWithNay(facts, contentType, brandContext) {
  return nay.requestDraft({ facts, contentType, brandContext: brandContext || {} });
}

module.exports = { buildFactsFromReadModel, generateDraftWithNay };
