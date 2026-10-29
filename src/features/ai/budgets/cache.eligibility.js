'use strict';

const { redactForStorage } = require('../security/piiRedactor');

const ALLOWED_CLASSES = Object.freeze(['PUBLIC', 'INTERNAL']);
// Só fontes do índice do RAG, cuja versão e vigência dá para conferir; memória, leitura de dado e ferramenta nunca entram no cache.
const ALLOWED_SOURCE_TYPES = Object.freeze(['KNOWLEDGE_ENTRY', 'DOCUMENT_CHUNK']);
const GROUNDED = Object.freeze(['GROUNDED', 'NOT_APPLICABLE']);

/** Há dado pessoal no texto? (a biblioteca única de redaction troca por [REDIGIDO:tipo]; se mudou, havia.) */
const hasPii = (text) => typeof text === 'string' && text !== '' && redactForStorage(text) !== text;

const listed = (cacheable, taskType) => (cacheable || []).some((t) => String(t).trim().toLowerCase() === String(taskType).trim().toLowerCase());

/**
 * Elegibilidade (M9-D015, todas verdadeiras): (1) habilitado e `taskType` na lista da versão do agente; (2) fontes só PUBLIC/INTERNAL;
 * (3) sem PII na entrada, na saída e nos trechos; (4) a resposta não é ação nem proposta; (5) grounding GROUNDED ou NOT_APPLICABLE.
 * Devolve { ok, reason } (reason: o primeiro critério que falhou).
 */
function checkEligibility({ enabled, taskType, cacheableTaskTypes, sources = [], texts = [], isAction = false, groundingStatus }) {
  if (!enabled) return { ok: false, reason: 'DISABLED' };
  if (!listed(cacheableTaskTypes, taskType)) return { ok: false, reason: 'TASK_NOT_CACHEABLE' };
  if (sources.some((s) => !ALLOWED_CLASSES.includes(s.classification))) return { ok: false, reason: 'CLASSIFICATION' };
  if (sources.some((s) => !ALLOWED_SOURCE_TYPES.includes(s.sourceType) || !s.sourceRef || !s.sourceVersion)) return { ok: false, reason: 'SOURCE_TYPE' };
  if ([...texts, ...sources.map((s) => s.text)].some(hasPii)) return { ok: false, reason: 'PII' };
  if (isAction) return { ok: false, reason: 'ACTION' };
  if (!GROUNDED.includes(groundingStatus)) return { ok: false, reason: 'NOT_GROUNDED' };
  return { ok: true, reason: null };
}

module.exports = { checkEligibility, hasPii, ALLOWED_CLASSES, ALLOWED_SOURCE_TYPES };
