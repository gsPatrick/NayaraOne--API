'use strict';

const SOURCE_KINDS = Object.freeze(['FILE', 'URL', 'KNOWLEDGE_ENTRY']);
const CLASSIFICATIONS = Object.freeze(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);
/** Ordem de sensibilidade (menor = mais livre): desempate do rerank e teto de classificação. */
const CLASSIFICATION_RANK = Object.freeze({ PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3 });
const INGESTION_STATUSES = Object.freeze(['PENDING', 'SCANNING', 'PARSING', 'INDEXING', 'INDEXED', 'REJECTED', 'FAILED']);
/** Etapas do pipeline, na ordem do Guia §6; gravadas em ai.ingestions.step. */
const STEPS = Object.freeze({
  authorize: 'AUTHORIZE', fetch: 'FETCH', scan: 'SCAN', hash: 'HASH', classify: 'CLASSIFY', parse: 'PARSE', secrets: 'SECRETS', chunk: 'CHUNK', embed: 'EMBED', index: 'INDEX', done: 'DONE',
});
const DEFAULT_PERMISSION = 'ai:use';
const INSUFFICIENT_MESSAGE = 'Não encontrei fontes que você possa consultar para responder.';

module.exports = { SOURCE_KINDS, CLASSIFICATIONS, CLASSIFICATION_RANK, INGESTION_STATUSES, STEPS, DEFAULT_PERMISSION, INSUFFICIENT_MESSAGE };
