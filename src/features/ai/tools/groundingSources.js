'use strict';

/**
 * Fontes exatas que uma tool de leitura declara em `groundingSources` (contrato, versão, cláusula e trecho literal, M9-D025). Quando a
 * tool as devolve, elas SÃO as fontes do run no lugar do despejo da saída inteira: a resposta cita o trecho que a prova (e o prazo
 * crítico só passa com fonte exata). Sem a lista, o orquestrador segue com a fonte genérica do resultado da tool.
 */
function groundingSourcesOf(toolName, output, retrievedAt) {
  const list = output && Array.isArray(output.groundingSources) ? output.groundingSources : [];
  const valid = list.filter((s) => s && typeof s.title === 'string' && typeof s.excerpt === 'string' && s.excerpt.trim());
  const when = output && output.asOf ? new Date(output.asOf) : retrievedAt;
  return valid.map((s) => ({
    sourceType: 'TOOL_RESULT', sourceRef: toolName, sourceVersion: s.version || null, title: s.title, clause: s.clause || null, text: s.excerpt,
    values: Array.isArray(s.values) ? s.values.map(String) : [], classification: 'INTERNAL', effectiveFrom: null, effectiveUntil: null, relevanceScore: null,
    statusAtRetrieval: 'VIGENTE', contentHash: null, longDocument: false, retrievedAt: when, usedInAnswer: true,
  }));
}

module.exports = { groundingSourcesOf };
