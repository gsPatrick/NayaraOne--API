'use strict';

/**
 * M9-D429 regra 5 — os 8 padrões do preview, por detecção determinística (sem IA), sobre o texto sem acento e em minúsculas (a posição de cada achado
 * é a mesma do texto original, porque a troca de letra acentuada preserva o tamanho). Padrões de trecho (CPF, CNPJ, número de contrato, endereço
 * completo) podem ser trocados por [REDIGIDO]; padrões de frase (valor de dívida, saldo, motivo de restrição, saúde) não: a frase inteira é o dado sensível.
 */
const fold = (text) => String(text === undefined || text === null ? '' : text).normalize('NFC').replace(/[À-ſ]/g, (c) => c.normalize('NFD')[0]).toLowerCase();

const CPF_RE = /(?<![\d.])\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}(?![\d])/g;
const CNPJ_RE = /(?<![\d.])\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?![\d])/g;
const ADDRESS_RE = /\b(?:rua|avenida|av|alameda|travessa|rodovia|estrada)\.?\s+[a-z0-9 ]{2,60}?,?\s*(?:n[o.]?\s*)?\d{1,5}\b/g;
const MONEY_RE = /r\$\s*\d[\d.,]*|\b\d[\d.,]*\s*(?:reais|real)\b/;

function cpfValid(digits) {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const calc = (len) => { let sum = 0; for (let i = 0; i < len; i += 1) sum += Number(digits[i]) * (len + 1 - i); const r = (sum * 10) % 11; return r === 10 ? 0 : r; };
  return calc(9) === Number(digits[9]) && calc(10) === Number(digits[10]);
}

function cnpjValid(digits) {
  if (!/^\d{14}$/.test(digits) || /^(\d)\1{13}$/.test(digits)) return false;
  const calc = (len) => { const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const sum = w.reduce((acc, x, i) => acc + x * Number(digits[i]), 0); const r = sum % 11; return r < 2 ? 0 : 11 - r; };
  return calc(12) === Number(digits[12]) && calc(13) === Number(digits[13]);
}

const span = (pattern, m) => ({ pattern, start: m.index, end: m.index + m[0].length, scope: 'SPAN' });

/** CPF e CNPJ com ou sem pontuação: sem nenhuma pontuação exigem dígitos verificadores válidos (telefone de 11 dígitos não é CPF). */
function documents(folded) {
  const found = [];
  for (const m of folded.matchAll(CNPJ_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (/[./-]/.test(m[0]) || cnpjValid(digits)) found.push(span('CNPJ', m));
  }
  for (const m of folded.matchAll(CPF_RE)) {
    const digits = m[0].replace(/\D/g, '');
    const overlapsCnpj = found.some((f) => f.pattern === 'CNPJ' && m.index < f.end && m.index + m[0].length > f.start);
    if (!overlapsCnpj && (/[.-]/.test(m[0]) || cpfValid(digits))) found.push(span('CPF', m));
  }
  return found;
}

/** Termo do dicionário no texto: mais de 3 letras = começo de palavra; até 3 letras = palavra inteira. */
function termRegex(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(term.length > 3 ? `(?<![a-z0-9])${escaped}` : `(?<![a-z0-9])${escaped}(?![a-z0-9])`);
}

/** Frases do texto com posição: corta em ponto/exclamação/interrogação seguidos de espaço, ponto e vírgula ou quebra de linha. */
function sentences(text) {
  const out = [];
  const rx = /[^.!?;\n]+(?:[.!?](?!\s|$)[^.!?;\n]*)*[.!?;]?/g;
  for (const m of text.matchAll(rx)) if (m[0].trim()) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

function bySentence(folded, terms) {
  const found = [];
  const sets = { DIVIDA: ['divida', true], SALDO: ['saldo', true], RESTRICAO: ['restricao', false], SAUDE: ['saude', false] };
  const compiled = Object.fromEntries(Object.entries(sets).map(([pattern, [group]]) => [pattern, (terms[group] || []).map((t) => termRegex(t.normalize('NFC').replace(/[À-ſ]/g, (c) => c.normalize('NFD')[0])))]));
  for (const s of sentences(folded)) {
    const hasMoney = MONEY_RE.test(s.text);
    for (const [pattern, [, needsMoney]] of Object.entries(sets)) {
      if (needsMoney && !hasMoney) continue;
      if (compiled[pattern].some((rx) => rx.test(s.text))) found.push({ pattern, start: s.start, end: s.end, scope: 'SENTENCE' });
    }
  }
  return found;
}

/** Todos os achados ({ pattern, start, end, scope }) dos 8 padrões, ordenados pela posição. `config` = { terms, contractPattern }. */
function detect(text, config) {
  const folded = fold(text);
  const found = [...documents(folded)];
  for (const m of folded.matchAll(new RegExp(config.contractPattern, 'gi'))) if (m[0]) found.push(span('CONTRATO', m));
  for (const m of folded.matchAll(ADDRESS_RE)) found.push(span('ENDERECO', m));
  found.push(...bySentence(folded, config.terms));
  return found.sort((a, b) => a.start - b.start || a.end - b.end);
}

module.exports = { detect, fold, cpfValid, cnpjValid };
