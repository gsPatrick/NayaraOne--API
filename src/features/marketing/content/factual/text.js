'use strict';

/**
 * M9-D407 — Texto de trabalho do validador factual. `fold` tira acento e caixa SEM mudar o tamanho do texto, então toda posição
 * achada no texto dobrado vale no original (para citar a afirmação). Cada extrator "consome" o trecho que explicou (mask), e o que
 * sobra é o que o passo final trata como afirmação inexplicável.
 */
function fold(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const unit = text[i];
    out += unit.normalize('NFD')[0].toLowerCase();
  }
  return out;
}

class Doc {
  constructor(text) {
    this.raw = String(text || '').normalize('NFC');
    this.work = fold(this.raw);
    this.used = new Array(this.raw.length).fill(false);
  }

  /** Marca [start, end) como explicado: o trecho some do texto de trabalho. */
  mask(start, end) {
    const blank = ' '.repeat(end - start);
    this.work = this.work.slice(0, start) + blank + this.work.slice(end);
    for (let i = start; i < end; i += 1) this.used[i] = true;
  }

  slice(start, end) {
    return this.raw.slice(start, end).trim();
  }

  /** Texto original com os trechos já explicados apagados (para os extratores que dependem de maiúsculas). */
  maskedRaw() {
    let out = '';
    for (let i = 0; i < this.raw.length; i += 1) out += this.used[i] ? ' ' : this.raw[i];
    return out;
  }

  /** Itera as ocorrências de `regex` (flag g) no texto de trabalho atual. */
  matches(regex, source = this.work) {
    return [...source.matchAll(regex)].map((m) => ({ m, start: m.index, end: m.index + m[0].length }));
  }
}

const WORD_NUMBERS = Object.freeze({
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
  treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20,
});
const WORD_PATTERN = Object.keys(WORD_NUMBERS).join('|');

/** "1.200,50" -> 1200.5; "0,78" -> 0.78; "120.5" -> 120.5. */
function parseBR(text) {
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) return Number(text.replace(/\./g, '').replace(',', '.'));
  return Number(text.replace(',', '.'));
}

/** Número ou número por extenso (até vinte) -> inteiro; qualquer outra coisa -> null. */
function parseCount(token) {
  const t = fold(String(token));
  if (/^\d+$/.test(t)) return Number(t);
  return Object.prototype.hasOwnProperty.call(WORD_NUMBERS, t) ? WORD_NUMBERS[t] : null;
}

const NUM = '(\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?|\\d+(?:[.,]\\d+)?)';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const present = (v) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');

module.exports = { fold, Doc, WORD_NUMBERS, WORD_PATTERN, parseBR, parseCount, NUM, escapeRe, present };
