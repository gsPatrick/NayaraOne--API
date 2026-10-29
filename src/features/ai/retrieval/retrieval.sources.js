'use strict';

const { recordSource } = require('../orchestrator/runs/runSources');
const { score } = require('./rerank');

/** Registra em ai.ai_sources cada chunk usado pelo run (id da fonte, versão, relevância e hash). O trecho passa pela redaction da M9-D027. */
async function recordRetrieved(ctx, items, transaction) {
  for (const i of items) {
    await recordSource(ctx, ctx.runId, {
      sourceType: i.sourceType === 'KNOWLEDGE_ENTRY' ? 'KNOWLEDGE_ENTRY' : 'DOCUMENT_CHUNK', sourceRef: i.sourceId, sourceVersion: String(i.sourceVersion),
      excerpt: i.content, classification: i.classification, effectiveFrom: i.effectiveFrom, effectiveUntil: i.effectiveUntil,
      relevanceScore: score(i.relevanceScore), statusAtRetrieval: 'VIGENTE', contentHash: i.contentHash,
    }, transaction);
  }
}

module.exports = { recordRetrieved };
