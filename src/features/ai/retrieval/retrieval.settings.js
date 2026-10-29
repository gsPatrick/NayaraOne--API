'use strict';

/**
 * Parâmetros do RAG da NAY (M9-D022; a busca e a reconciliação acrescentam os seus na M9-D023), na aba IA NAY de Configurações. Padrão = valor inicial de Maturacao/demandas/parametros.csv.
 * `ia.rag.segredos_rejeitar_percentual` e `ia.rag.embedding_lote` são do livro omisso: o primeiro é o "majoritariamente" da rejeição de
 * documento de segredos, o segundo o tamanho do lote enviado ao provider de vetores.
 */
const RAG_KEYS = Object.freeze({
  indexRestricted: 'ia.rag.indexar_restricted',
  allowedDomains: 'ia.rag.dominios_permitidos',
  chunkTokens: 'ia.rag.chunk_tokens',
  chunkOverlap: 'ia.rag.chunk_overlap',
  secretsRejectPercent: 'ia.rag.segredos_rejeitar_percentual',
  embeddingBatch: 'ia.rag.embedding_lote',
});

const RAG_SETTING_DEFAULTS = Object.freeze({
  [RAG_KEYS.indexRestricted]: false,
  [RAG_KEYS.allowedDomains]: '',
  [RAG_KEYS.chunkTokens]: 400,
  [RAG_KEYS.chunkOverlap]: 50,
  [RAG_KEYS.secretsRejectPercent]: 50,
  [RAG_KEYS.embeddingBatch]: 16,
});

const RAG_SETTINGS_SCHEMA = {
  [RAG_KEYS.indexRestricted]: { type: 'boolean' },
  [RAG_KEYS.allowedDomains]: { type: 'string' },
  [RAG_KEYS.chunkTokens]: { type: 'integer', min: 50, max: 2000 },
  [RAG_KEYS.chunkOverlap]: { type: 'integer', min: 0, max: 500 },
  [RAG_KEYS.secretsRejectPercent]: { type: 'integer', min: 1, max: 100 },
  [RAG_KEYS.embeddingBatch]: { type: 'integer', min: 1, max: 256 },
};

module.exports = { RAG_KEYS, RAG_SETTING_DEFAULTS, RAG_SETTINGS_SCHEMA };
