'use strict';

/**
 * Memória -> fonte do ContextBuilder (M9-D027). Cada lembrança vira uma fonte `memoria` com tipo, valor e origem (para citar), na
 * classificação da própria memória; o portão de classificação, a minimização e a redaction seguem valendo. A tarefa que usa memória
 * lista MEMORY_CONTEXT_FIELDS entre os seus campos permitidos.
 */
const MEMORY_SOURCE_KEY = 'memoria';
const MEMORY_CONTEXT_FIELDS = Object.freeze(['memoria.tipo', 'memoria.valor', 'memoria.origem']);

function toContextSources(ctx, memories) {
  return memories.map((m) => ({
    id: m.id,
    key: MEMORY_SOURCE_KEY,
    classification: m.classification,
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    fields: { tipo: m.memoryType, valor: m.value, origem: `${m.sourceType}:${m.sourceId}` },
  }));
}

module.exports = { toContextSources, MEMORY_SOURCE_KEY, MEMORY_CONTEXT_FIELDS };
