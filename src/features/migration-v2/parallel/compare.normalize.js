'use strict';

/**
 * Normalização dos valores antes de comparar (M9-D903 §3.3). Cada função devolve um texto canônico (ou null para ausente) que é o que se compara e o que se resume em hash;
 * a comparação é sempre sobre o valor REAL, nunca sobre o que a tela mostra com máscara.
 */
const DECIMAL = /^([+-]?)(\d*)\.?(\d*)$/;

/** Texto NFC sem espaços nas pontas; vazio e ausente são a mesma coisa (null). */
function text(value) {
  if (value === null || value === undefined) return null;
  const out = String(value).normalize('NFC').trim();
  return out === '' ? null : out;
}

/** { n: BigInt, s: casas } sem zeros à direita nas casas; null se o texto não é um decimal simples. */
function parseDecimal(value) {
  const raw = text(value);
  if (raw === null) return null;
  const match = DECIMAL.exec(raw.replace(',', '.'));
  if (!match || (match[2] === '' && match[3] === '')) return null;
  let digits = `${match[2]}${match[3]}`;
  let scale = match[3].length;
  while (scale > 0 && digits.endsWith('0')) { digits = digits.slice(0, -1); scale -= 1; }
  const n = BigInt(digits || '0');
  return { n: match[1] === '-' ? -n : n, s: scale };
}

function format({ n, s }) {
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString().padStart(s + 1, '0');
  const body = s ? `${digits.slice(0, -s)}.${digits.slice(-s)}` : digits;
  return (negative ? '-' : '') + body;
}

const pow10 = (k) => 10n ** BigInt(k);
function align(a, b) {
  const s = Math.max(a.s, b.s);
  return [a.n * pow10(s - a.s), b.n * pow10(s - b.s), s];
}

/** Valor monetário em centavos, em texto exato. `unit` CENTS (já em centavos) ou DECIMAL (reais com casas). Centavo fracionado fica fracionado (nunca arredonda). */
function cents(value, unit) {
  const dec = parseDecimal(value);
  if (dec === null) return text(value) === null ? null : `INVALID:${text(value)}`;
  if (unit !== 'DECIMAL') return format(dec);
  return format({ n: dec.s >= 2 ? dec.n : dec.n * pow10(2 - dec.s), s: Math.max(dec.s - 2, 0) });
}

/** Decimal exato em texto (sem zeros à direita). */
function numeric(value) {
  const dec = parseDecimal(value);
  if (dec === null) return text(value) === null ? null : `INVALID:${text(value)}`;
  return format(dec);
}

/** |a - b| <= tolerância, em aritmética exata. Valor inválido nunca está dentro da tolerância. */
function withinTolerance(a, b, tolerance) {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  const tol = parseDecimal(tolerance === undefined || tolerance === null ? 0 : tolerance);
  if (!left || !right || !tol) return false;
  const [x, y, s] = align(left, right);
  const [d, t] = align({ n: (x > y ? x - y : y - x), s }, tol);
  return d <= t;
}

const dayInTimezone = (date, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

/** Dia civil (AAAA-MM-DD) no fuso pedido. Data sem hora e data/hora sem deslocamento já são o dia civil do fuso; com deslocamento (ou Date) converte para o fuso. */
function civilDay(value, timeZone) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'INVALID:Date' : dayInTimezone(value, timeZone);
  const raw = text(value);
  if (raw === null) return null;
  const plain = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.exec(raw);
  if (plain) return plain[1];
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? `INVALID:${raw}` : dayInTimezone(parsed, timeZone);
}

module.exports = { text, cents, numeric, civilDay, withinTolerance, parseDecimal };
