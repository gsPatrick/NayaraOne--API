'use strict';

// Quais fontes valem como "suficientes" (Caderno §10, AI-009): usada na resposta, vigente e com relevância mínima.

const C = require('./grounding.constants');
const { entityKeys, withYears } = require('../numbers/textEntities');

/** Normaliza o formato do registro (ai_sources) e o formato de leitura direta (read model) para um só. */
function normalizeSource(raw, index) {
  const s = raw || {};
  return {
    ref: index + 1,
    sourceType: s.sourceType || s.type || null,
    sourceRef: s.sourceRef || s.id || null,
    title: s.title || s.sourceRef || null,
    version: s.version ?? s.sourceVersion ?? null,
    clause: s.clause || null,
    excerpt: s.excerpt || null,
    values: Array.isArray(s.values) ? s.values.map(String) : [],
    classification: s.classification || null,
    effectiveFrom: s.effectiveFrom || null,
    effectiveUntil: s.effectiveUntil || null,
    retrievedAt: s.retrievedAt || s.asOf || null,
    relevanceScore: s.relevanceScore === undefined ? null : s.relevanceScore,
    usedInAnswer: s.usedInAnswer !== false,
    status: s.status || s.statusAtRetrieval || null,
  };
}

/** Relevância efetiva: fonte de read model/tool é exata (1); trecho recuperado sem pontuação não prova nada (0). */
function effectiveRelevance(source) {
  if (source.relevanceScore !== null && source.relevanceScore !== undefined) return Number(source.relevanceScore);
  return C.TIPOS_DETERMINISTICOS.includes(source.sourceType) ? 1 : 0;
}

function isEligible(source, settings) {
  if (!source.usedInAnswer) return false;
  if (C.STATUS_FONTE_INVALIDA.includes(source.status)) return false;
  if (!(effectiveRelevance(source) >= settings.relevanciaMinima)) return false;
  return Boolean(source.excerpt || source.values.length);
}

/** Chaves canônicas (números, datas, ids) que a fonte contém: o que a resposta pode afirmar citando-a. */
function keysOfSource(source) {
  return withYears(entityKeys([source.excerpt, source.clause, ...source.values].filter(Boolean).join(' \n ')));
}

/** Fonte exata para contrato/prazo crítico: contrato (título), versão, cláusula e trecho literal. */
const isExact = (s) => Boolean(s.title && s.version && s.clause && s.excerpt && String(s.excerpt).trim());

module.exports = { normalizeSource, effectiveRelevance, isEligible, keysOfSource, isExact };
