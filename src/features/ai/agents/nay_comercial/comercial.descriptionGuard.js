'use strict';

// Guia do Marcelo (Marco 3) §12: validateGeneratedDescription(output, approvedFacts). Livro §16: "Não afirma característica ausente nem
// inventa metragem"; §19 CRM-TS-011 "AI hallucination — Campo ausente — Descrição não inventa". Função pura: confere cada frase da
// descrição contra os fatos públicos aprovados (comercial.publicFacts.js) e devolve as violações e o texto corrigido (sem as frases que
// afirmam o que não está nos fatos). Confere: metragem (m², metros quadrados), quantidade de quartos/dormitórios, suítes, banheiros e
// vagas, valores em R$ e os termos controlados (características, acabamentos, localização e benefícios; parâmetro
// `ia.comercial.descricao.termos_controlados`), que só podem aparecer quando algum fato aprovado os contém.
const { splitSentences } = require('../../orchestrator/grounding/sentences');
const { semAcento } = require('../../orchestrator/numbers/decimalText');

const norm = (t) => semAcento(String(t || '')).replace(/\s+/g, ' ').trim();
const WORD_NUM = Object.freeze({ um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10 });
const AREA = /(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)\s*(?:m2|m²|metros quadrados|metro quadrado|mts2|mt2)/g;
const COUNT = /\b(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+(quartos?|dormitorios?|suites?|banheiros?|vagas?|garage(?:m|ns))\b/g;
const MONEY = /r\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/g;
const ROOM_FACT = Object.freeze({ quarto: 'bedrooms', dormitorio: 'bedrooms', banheiro: 'bathrooms', vaga: 'parking_spots', garage: 'parking_spots', suite: null });

/** "1.234,5" / "120" / "120.5" -> número. */
function toNumber(text) {
  const t = String(text);
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
  return Number(t.replace(',', '.'));
}

const same = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005;
const factRaw = (facts, key) => { const f = facts.find((x) => x.key === key); return f ? Number(f.raw) : null; };
const roomKind = (word) => Object.keys(ROOM_FACT).find((k) => word.startsWith(k));
const wordStart = (text, term) => new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text);

function sentenceViolations(sentence, facts, controlled, factsBlob) {
  const s = norm(sentence);
  const out = [];
  for (const m of s.matchAll(AREA)) {
    const n = toNumber(m[1]);
    if (![factRaw(facts, 'area_total'), factRaw(facts, 'area_built')].some((v) => same(v, n))) out.push({ kind: 'METRAGEM_INVENTADA', detail: m[0] });
  }
  for (const m of s.matchAll(COUNT)) {
    const n = WORD_NUM[m[1]] || Number(m[1]);
    const key = ROOM_FACT[roomKind(m[2])];
    if (!key || !same(factRaw(facts, key), n)) out.push({ kind: key ? 'QUANTIDADE_INVENTADA' : 'CARACTERISTICA_AUSENTE', detail: m[0] });
  }
  for (const m of s.matchAll(MONEY)) {
    const n = toNumber(m[1]);
    if (!['price_public', 'condo_fee_public', 'iptu_public'].some((k) => same(factRaw(facts, k), n))) out.push({ kind: 'VALOR_INVENTADO', detail: m[0] });
  }
  for (const term of controlled) {
    if (wordStart(s, term) && !wordStart(factsBlob, term)) out.push({ kind: 'CARACTERISTICA_AUSENTE', detail: term });
  }
  return out;
}

/**
 * @param {string} output texto gerado (pelo modelo ou pelo código)
 * @param {Array<{key,label,value,raw}>} approvedFacts fatos públicos aprovados
 * @param {{ controlledTerms?: string[] }} options termos controlados (já normalizados, sem acento)
 * @returns {{ ok: boolean, violations: Array<{ kind, detail, sentence }>, text: string, kept: number }}
 */
function validateGeneratedDescription(output, approvedFacts, { controlledTerms = [] } = {}) {
  const facts = Array.isArray(approvedFacts) ? approvedFacts : [];
  const factsBlob = norm(facts.map((f) => `${f.label} ${f.value}`).join(' . '));
  const controlled = controlledTerms.map(norm).filter(Boolean);
  const violations = [];
  const kept = [];
  for (const sentence of splitSentences(output)) {
    const found = sentenceViolations(sentence, facts, controlled, factsBlob);
    if (found.length) violations.push(...found.map((v) => ({ ...v, sentence })));
    else kept.push(sentence);
  }
  return { ok: violations.length === 0, violations, text: kept.join(/\n/.test(String(output || '')) ? '\n' : ' '), kept: kept.length };
}

module.exports = { validateGeneratedDescription };
