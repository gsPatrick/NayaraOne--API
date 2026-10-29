'use strict';

// Conflito entre fontes (M9-D024): a resposta não escolhe um lado. Frase que afirma o valor de UMA das versões divergentes sai do texto;
// o bloco "Atenção: as fontes divergem" (citationBuilder) lista cada fonte com versão, vigência e valor.

const C = require('./grounding.constants');
const { splitSentences } = require('./sentences');

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Valores (como escritos nas fontes) de todas as versões divergentes. */
const valuesOf = (conflicts) => [...new Set((conflicts || []).flatMap((c) => (c.versions || []).map((v) => String(v.value || '').trim())).filter(Boolean))];

function mentions(sentence, values) {
  return values.some((v) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(v)}(?![\\p{L}\\p{N}])`, 'iu').test(sentence));
}

/** Tira do corpo da resposta (antes do bloco de divergência) as frases que escolhem um dos valores; o bloco fica como está. */
function withoutChosenSide(answer, conflicts) {
  const at = String(answer).indexOf(C.MENSAGEM_DIVERGENCIA);
  if (at < 0) return answer;
  const body = answer.slice(0, at).trim();
  const block = answer.slice(at);
  const values = valuesOf(conflicts);
  const kept = splitSentences(body).filter((s) => !mentions(s, values));
  return kept.length ? `${kept.join(/\n/.test(body) ? '\n' : ' ')}\n\n${block}` : block;
}

module.exports = { withoutChosenSide };
