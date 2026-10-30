'use strict';

/**
 * Parâmetros do RAG da NAY (M9-D022 e M9-D023), na aba IA NAY de Configurações. Padrão = valor inicial de Maturacao/demandas/parametros.csv.
 * `ia.rag.segredos_rejeitar_percentual` e `ia.rag.embedding_lote` são do livro omisso: o primeiro é o "majoritariamente" da rejeição de
 * documento de segredos, o segundo o tamanho do lote enviado ao provider de vetores. M9-D024: `ia.rag.conflito.marcador` é a palavra que
 * abre a linha em que um documento declara o valor de um fato ("Fato: chave = valor"), `ia.rag.nao_vigentes_registrar_max` quantas fontes
 * não vigentes que casaram com a pergunta o run registra (0 = nenhuma) e `ia.rag.vigencia.intervalo_horas` o intervalo do job que marca vencidas.
 * `ia.rag.consulta_max_caracteres` é o tamanho máximo do texto de uma busca (a pergunta vai para a busca por palavras e por vetor).
 */
const RAG_KEYS = Object.freeze({
  indexRestricted: 'ia.rag.indexar_restricted',
  allowedDomains: 'ia.rag.dominios_permitidos',
  chunkTokens: 'ia.rag.chunk_tokens',
  chunkOverlap: 'ia.rag.chunk_overlap',
  topK: 'ia.rag.top_k',
  contextMaxChunks: 'ia.rag.contexto_max_chunks',
  reconcileMinutes: 'ia.rag.reconciliar_minutos',
  secretsRejectPercent: 'ia.rag.segredos_rejeitar_percentual',
  embeddingBatch: 'ia.rag.embedding_lote',
  factMarker: 'ia.rag.conflito.marcador',
  nonVigentMax: 'ia.rag.nao_vigentes_registrar_max',
  expiryHours: 'ia.rag.vigencia.intervalo_horas',
  queryMax: 'ia.rag.consulta_max_caracteres',
});

const RAG_SETTING_DEFAULTS = Object.freeze({
  [RAG_KEYS.indexRestricted]: false,
  [RAG_KEYS.allowedDomains]: '',
  [RAG_KEYS.chunkTokens]: 400,
  [RAG_KEYS.chunkOverlap]: 50,
  [RAG_KEYS.topK]: 20,
  [RAG_KEYS.contextMaxChunks]: 6,
  [RAG_KEYS.reconcileMinutes]: 5,
  [RAG_KEYS.secretsRejectPercent]: 50,
  [RAG_KEYS.embeddingBatch]: 16,
  [RAG_KEYS.factMarker]: 'Fato',
  [RAG_KEYS.nonVigentMax]: 5,
  [RAG_KEYS.expiryHours]: 24,
  [RAG_KEYS.queryMax]: 2000,
});

const RAG_SETTINGS_SCHEMA = {
  [RAG_KEYS.indexRestricted]: { type: 'boolean' },
  [RAG_KEYS.allowedDomains]: { type: 'string' },
  [RAG_KEYS.chunkTokens]: { type: 'integer', min: 50, max: 2000 },
  [RAG_KEYS.chunkOverlap]: { type: 'integer', min: 0, max: 500 },
  [RAG_KEYS.topK]: { type: 'integer', min: 1, max: 100 },
  [RAG_KEYS.contextMaxChunks]: { type: 'integer', min: 1, max: 30 },
  [RAG_KEYS.reconcileMinutes]: { type: 'integer', min: 1, max: 1440 },
  [RAG_KEYS.secretsRejectPercent]: { type: 'integer', min: 1, max: 100 },
  [RAG_KEYS.embeddingBatch]: { type: 'integer', min: 1, max: 256 },
  [RAG_KEYS.factMarker]: { type: 'string' },
  [RAG_KEYS.nonVigentMax]: { type: 'integer', min: 0, max: 50 },
  [RAG_KEYS.expiryHours]: { type: 'integer', min: 1, max: 168 },
  [RAG_KEYS.queryMax]: { type: 'integer', min: 1, max: 20000 },
};

module.exports = { RAG_KEYS, RAG_SETTING_DEFAULTS, RAG_SETTINGS_SCHEMA };
