'use strict';

const { norm } = require('../scope/scope.evaluate');
const { parseVocabulary } = require('./vocabulary');

/**
 * Classificação sugerida (M9-D040): por regra sobre o vocabulário da empresa (`ia.documental.tipos_documento`), sem modelo. Para cada
 * tipo conta quantos termos distintos aparecem no texto; a confiança do melhor é `acertos / (acertos + acertos do segundo + 1)`. Sem
 * nenhum termo, o tipo é OTHER e a confiança 0 (a NAY nunca inventa um tipo). O resultado é só sugestão: nada é gravado.
 */
const NO_MATCH = Object.freeze({ suggestedType: 'OTHER', confidence: 0, lowConfidence: true, alternatives: [], evidence: [] });

const share = (hits, others) => Math.round((hits / (hits + others + 1)) * 100) / 100;

function classifyText(text, vocabularyRaw, minConfidence) {
  const haystack = norm(text);
  const scored = [...parseVocabulary(vocabularyRaw).entries()]
    .map(([type, terms]) => ({ type, hits: terms.filter((t) => haystack.includes(t)) }))
    .filter((s) => s.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length || a.type.localeCompare(b.type));
  const [best, second] = scored;
  return scored.length === 0 ? NO_MATCH : {
    suggestedType: best.type, confidence: share(best.hits.length, second ? second.hits.length : 0), lowConfidence: share(best.hits.length, second ? second.hits.length : 0) < minConfidence,
    alternatives: scored.slice(1, 4).map((s) => ({ type: s.type, confidence: share(s.hits.length, best.hits.length) })),
    evidence: best.hits.slice(0, 5),
  };
}

module.exports = { classifyText };
