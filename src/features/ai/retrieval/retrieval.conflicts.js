'use strict';

const { declaredFacts, knowledgeFact } = require('./facts');
const { detectConflicts } = require('./conflictDetector');

/**
 * Fatos que cada chunk recuperado declara (M9-D024): Map chunkId -> [{ key, raw, value }]. Conhecimento homologado declara o próprio
 * fato (chave e valor da entrada); documento e link declaram por linha `<marcador>: <chave> = <valor>`.
 */
async function factsOfChunks(ctx, candidates, rowsById, marker, transaction) {
  const out = new Map();
  for (const c of candidates) {
    const row = rowsById.get(c.id);
    const list = c.sourceType === 'KNOWLEDGE_ENTRY'
      ? [await knowledgeFact(ctx, c.sourceId, transaction)].filter(Boolean)
      : declaredFacts(row.contentRedacted, marker);
    if (list.length) out.set(c.id, list);
  }
  return out;
}

/** Conflitos entre os candidatos vigentes (sem `ref`: o número do marcador só existe na resposta). */
function conflictsOf(candidates, facts) {
  return detectConflicts(candidates.filter((c) => facts.has(c.id)).map((c) => ({
    sourceType: c.sourceType, sourceRef: c.sourceId, title: `${c.sourceType} ${c.sourceId}`, sourceVersion: c.sourceVersion,
    effectiveFrom: c.effectiveFrom, effectiveUntil: c.effectiveUntil, facts: facts.get(c.id), ref: null,
  })));
}

module.exports = { factsOfChunks, conflictsOf };
