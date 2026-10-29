'use strict';

// M9-D025/D026 — verificador determinístico de entidades do texto: números (com unidade R$ e %), datas, identificadores.
// Marcadores de citação [n], placeholders {{num:ref}}, horas, ordinais (1º) e numeração de lista não são entidades.

const { parseNumberText, scaled, SCALES, semAcento } = require('./decimalText');

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const BR_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g;
const DAY_MONTH = /\b(\d{1,2})\/(\d{1,2})\b/g;
const CODE = /(?<![\w$])[A-Za-z]{1,12}[-_]?\d[\w./-]*/g;
const NUMBER = /(?<![\w.,])(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)(\s*%)?(?:\s+(mil|milh(?:ão|ões|ao|oes)|bilh(?:ão|ões|ao|oes)|mi|bi)\b)?(?![\w])/gi;

const pad = (n) => String(n).padStart(2, '0');

function yearOf(y) { return y.length === 2 ? `20${y}` : y; }

/** Troca cada trecho que casa com `re` por espaços (mantém posições), registrando a entidade que `build` monta. */
function takeAll(text, re, build) {
  return text.replace(re, (...args) => {
    const groups = args.slice(0, args.length - 2);
    build(groups);
    return ' '.repeat(groups[0].length);
  });
}

/**
 * Entidades do texto: [{ kind: 'n'|'d'|'i', key, raw, unit }]. `key` é a forma canônica para comparar (número decimal exato,
 * data ISO, identificador em minúsculas). Ano isolado (1900-2100) é `kind: 'y'`.
 */
function extractEntities(input) {
  let text = String(input || '');
  const entities = [];
  text = text.replace(/\{\{num:[^}]*\}\}/g, ' ').replace(/\[\d+\]/g, ' ');
  text = text.replace(/(^|\n)\s*\d+[.)]\s/g, '$1 ').replace(/\b\d+\s?[ºª°]/g, ' ').replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');
  const push = (item) => entities.push(item);
  text = takeAll(text, UUID, ([raw]) => push({ kind: 'i', key: raw.toLowerCase(), raw }));
  text = takeAll(text, ISO_DATE, ([raw, y, m, d]) => push({ kind: 'd', key: `${y}-${m}-${d}`, raw }));
  text = takeAll(text, BR_DATE, ([raw, d, m, y]) => push({ kind: 'd', key: `${yearOf(y)}-${pad(m)}-${pad(d)}`, raw }));
  text = takeAll(text, DAY_MONTH, ([raw, d, m]) => push({ kind: 'd', key: `--${pad(m)}-${pad(d)}`, raw }));
  text = takeAll(text, CODE, ([raw]) => push({ kind: 'i', key: raw.toLowerCase(), raw }));
  const moneyPrefix = /R\$\s*$/;
  text.replace(NUMBER, (raw, digits, pct, word, offset) => {
    let value = parseNumberText(digits);
    if (value === null) return raw;
    if (word) value = scaled(value, word);
    const year = !word && !pct && /^\d{4}$/.test(digits) && Number(digits) >= 1900 && Number(digits) <= 2100;
    const unit = pct ? '%' : (moneyPrefix.test(text.slice(0, offset)) ? 'BRL' : null);
    push({ kind: year ? 'y' : 'n', key: value, raw: raw.trim(), unit });
    return raw;
  });
  return entities;
}

/** Conjunto de chaves canônicas (`n:18432.5`, `d:2026-11-30`, `i:ct-1`) de um texto. */
function entityKeys(text) {
  return new Set(extractEntities(text).flatMap((e) => (e.kind === 'y' ? [`y:${e.key}`, `n:${e.key}`] : [`${e.kind}:${e.key}`])));
}

/** Data ISO completa vira também a chave do ano e a do dia/mês ("2026" e "30/11" casam com 30/11/2026). */
function withYears(keys) {
  const out = new Set(keys);
  for (const k of keys) {
    if (k.startsWith('d:') && /^d:\d{4}-\d{2}-\d{2}$/.test(k)) { out.add(`y:${k.slice(2, 6)}`); out.add(`d:--${k.slice(7)}`); }
  }
  return out;
}

module.exports = { extractEntities, entityKeys, withYears, SCALES, semAcento };
