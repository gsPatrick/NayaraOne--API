'use strict';

/**
 * M9-D427 regra 5 — regra mecânica da afirmação factual (sem IA): todo parágrafo que contém número, percentual, data, valor em reais ou nome
 * de lei/norma precisa de ao menos uma referência [n] que aponte para um item existente de `sources[]`. Os padrões abaixo são os "detectados
 * por padrão" do livro; os marcadores [n] são retirados antes da busca (o número da referência não é afirmação).
 */
const REF_RE = /\[(\d{1,3})\]/g;
const LAW_RE = /\b(?:Lei|Decreto(?:-Lei)?|Resolução|Portaria|Instrução Normativa|Medida Provisória|Emenda Constitucional|Súmula|Provimento)\b|\b(?:Código (?:Civil|de Processo Civil|de Defesa do Consumidor|Tributário Nacional)|Constituição Federal|Estatuto da Cidade|LGPD|CDC|NBR)\b/;
const WORD_MONEY_RE = /\b(?:reais|real|por cento|porcento|milhão|milhões|bilhão|bilhões)\b/i;
const MONTH_RE = /\b(?:janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/i;

const isHeading = (line) => /^\s*#{1,6}\s/.test(line);

/** Parágrafos (separados por linha em branco), sem as linhas de título. */
function splitParagraphs(text) {
  return String(text || '').split(/\n\s*\n/).map((p) => p.split('\n').filter((line) => !isHeading(line)).join('\n').trim()).filter(Boolean);
}

/** Por que o parágrafo é afirmação factual: lista dos padrões que casaram (vazia = não é). */
function factualSignals(paragraph) {
  const clean = paragraph.replace(REF_RE, ' ');
  const signals = [];
  if (/\d/.test(clean)) signals.push('NUMBER');
  if (WORD_MONEY_RE.test(clean)) signals.push('MONEY_OR_PERCENT_WORD');
  if (MONTH_RE.test(clean) && /\bde\s+(?:19|20)\d{2}\b|\b\d{1,2}\s+de\b/i.test(paragraph)) signals.push('DATE');
  if (LAW_RE.test(clean)) signals.push('LAW_OR_NORM');
  return signals;
}

/** Números de referência [n] que o parágrafo cita. */
const referencesOf = (paragraph) => [...paragraph.matchAll(REF_RE)].map((m) => Number(m[1]));

/** Palavras do artigo (sem marcadores [n] nem símbolos de título). */
function countWords(text) {
  return String(text || '').replace(REF_RE, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

module.exports = { splitParagraphs, factualSignals, referencesOf, countWords };
