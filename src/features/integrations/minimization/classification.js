'use strict';

/**
 * Escalas de classificação (M9-D219 3.1). A escala de CAMPO DE INTEGRAÇÃO (PUBLIC < INTERNAL < CONFIDENTIAL < PERSONAL <
 * SENSITIVE) e a escala de DOCUMENTOS/IA (PUBLIC < INTERNAL < CONFIDENTIAL < RESTRICTED) têm nomes diferentes; esta é a
 * tabela única de equivalência (dona: a D219):
 *   PUBLIC = PUBLIC, INTERNAL = INTERNAL, CONFIDENTIAL = CONFIDENTIAL, PERSONAL = CONFIDENTIAL, SENSITIVE = RESTRICTED.
 * Na direção documento/IA -> integração: RESTRICTED vale SENSITIVE e CONFIDENTIAL vale PERSONAL quando o campo tem dado
 * pessoal (CONFIDENTIAL caso contrário).
 */
const INTEGRATION_SCALE = Object.freeze(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'SENSITIVE']);
const DOCUMENT_SCALE = Object.freeze(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);

const INTEGRATION_TO_DOCUMENT = Object.freeze({
  PUBLIC: 'PUBLIC', INTERNAL: 'INTERNAL', CONFIDENTIAL: 'CONFIDENTIAL', PERSONAL: 'CONFIDENTIAL', SENSITIVE: 'RESTRICTED',
});

const rank = (classification) => INTEGRATION_SCALE.indexOf(classification);
const isIntegrationClass = (value) => INTEGRATION_SCALE.includes(value);

/** Integração -> documentos/IA. Valor desconhecido devolve null (nunca presume). */
function toDocumentScale(classification) {
  return INTEGRATION_TO_DOCUMENT[classification] || null;
}

/** Documentos/IA -> integração. `hasPersonalData` decide CONFIDENTIAL entre PERSONAL e CONFIDENTIAL. Desconhecido: null. */
function fromDocumentScale(classification, { hasPersonalData = false } = {}) {
  if (classification === 'RESTRICTED') return 'SENSITIVE';
  if (classification === 'CONFIDENTIAL') return hasPersonalData ? 'PERSONAL' : 'CONFIDENTIAL';
  return DOCUMENT_SCALE.includes(classification) ? classification : null;
}

/** true quando `classification` é MAIS sensível que o `max` permitido. Classe desconhecida conta como acima (falha fechada). */
function exceeds(classification, max) {
  const c = rank(classification);
  const m = rank(max);
  return c < 0 || m < 0 || c > m;
}

const lowest = (a, b) => (rank(a) <= rank(b) ? a : b);

module.exports = { INTEGRATION_SCALE, DOCUMENT_SCALE, INTEGRATION_TO_DOCUMENT, rank, isIntegrationClass, toDocumentScale, fromDocumentScale, exceeds, lowest };
