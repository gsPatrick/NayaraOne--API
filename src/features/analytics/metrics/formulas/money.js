'use strict';

/**
 * M9-D605 (3.2) — o ÚNICO utilitário decimal das fórmulas do BI. Aritmética exata sobre inteiros BigInt escalados ({ n, s } = n / 10^s):
 * sem ponto flutuante, sem relógio, sem sorteio (a regra de lint `nayara/no-float-money` vigia esta pasta). Soma e multiplicação não
 * arredondam; arredonda-se UMA vez, no resultado do KPI, no modo único meio para cima afastando do zero (0,005 -> 0,01; -0,005 -> -0,01).
 * Entradas são texto decimal ("1000.50"), inteiro seguro ou BigInt; outra coisa dá 422 ANALYTICS_FORMULA_INPUT_INVALID.
 */
const { inputInvalid } = require('../formulaErrors');

const NUMBER_RE = /^(-?)(\d+)(?:\.(\d+))?$/;
const PRECISION = 28; // casas da divisão (a demanda manda precisão 28)

const pow10 = (k) => 10n ** BigInt(k);
const make = (n, s) => ({ n, s });

function dec(value) {
  if (value !== null && typeof value === 'object' && typeof value.n === 'bigint' && Number.isInteger(value.s)) return value;
  if (typeof value === 'bigint') return make(value, 0);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw inputInvalid();
    return make(BigInt(value), 0);
  }
  if (typeof value === 'string') {
    const m = NUMBER_RE.exec(value.trim());
    if (!m) throw inputInvalid();
    const fraction = m[3] || '';
    return make(BigInt(`${m[1]}${m[2]}${fraction}`), fraction.length);
  }
  throw inputInvalid();
}

function align(a, b) {
  const x = dec(a);
  const y = dec(b);
  const s = x.s >= y.s ? x.s : y.s;
  return [x.n * pow10(s - x.s), y.n * pow10(s - y.s), s];
}

function add(a, b) { const [x, y, s] = align(a, b); return make(x + y, s); }
function sub(a, b) { const [x, y, s] = align(a, b); return make(x - y, s); }
function mul(a, b) { const x = dec(a); const y = dec(b); return make(x.n * y.n, x.s + y.s); }
function cmp(a, b) { const [x, y] = align(a, b); if (x === y) return 0; return x < y ? -1 : 1; }
function isZero(a) { return dec(a).n === 0n; }
function sum(list) { return list.reduce((acc, v) => add(acc, v), make(0n, 0)); }

/** Divisão com 28 casas (truncada). Divisor zero devolve null: quem chama decide (INCOMPLETE), nunca vira 0 nem infinito. */
function div(a, b, digits = PRECISION) {
  const x = dec(a);
  const y = dec(b);
  if (y.n === 0n) return null;
  return make((x.n * pow10(digits + y.s)) / (y.n * pow10(x.s)), digits);
}

/** Meio para cima, afastando do zero, para `places` casas (modo único de todo o BI). */
function roundHalfUp(value, places) {
  const d = dec(value);
  if (d.s <= places) return make(d.n * pow10(places - d.s), places);
  const unit = pow10(d.s - places);
  const negative = d.n < 0n;
  const abs = negative ? -d.n : d.n;
  let q = abs / unit;
  if ((abs % unit) * 2n >= unit) q += 1n;
  return make(negative ? -q : q, places);
}

function toString(value) {
  const d = dec(value);
  const negative = d.n < 0n;
  let digits = (negative ? -d.n : d.n).toString();
  if (d.s > 0) {
    digits = digits.padStart(d.s + 1, '0');
    digits = `${digits.slice(0, -d.s)}.${digits.slice(-d.s)}`;
  }
  return negative ? `-${digits}` : digits;
}

const round = (value, places) => toString(roundHalfUp(value, places));
const money = (value) => round(value, 2); // dinheiro: 2 casas
const hours = (value) => round(value, 1); // horas: 1 casa

/** Contagem: inteiro. Valor com fração dá 422. */
function count(value) {
  const d = dec(value);
  const unit = pow10(d.s);
  if (d.n % unit !== 0n) throw inputInvalid();
  return toString(make(d.n / unit, 0));
}

/** Percentual com 2 casas (12,35%). Base zero ou negativa não tem percentual que se possa ler: { value: null, status: 'INCOMPLETE' } (nunca 0 nem sinal trocado). */
function percent(numerator, denominator) {
  if (cmp(denominator, 0) < 0) return { value: null, status: 'INCOMPLETE' };
  const ratio = div(numerator, denominator);
  if (ratio === null) return { value: null, status: 'INCOMPLETE' };
  return { value: round(mul(ratio, 100), 2), status: 'OK' };
}

/** Resultado de uma razão já calculada (null = divisão por zero). */
function ratioResult(ratio) {
  return ratio === null ? { value: null, status: 'INCOMPLETE' } : { value: toString(ratio), status: 'OK' };
}

/**
 * Total calculado dos valores exatos e arredondado uma só vez; as partes arredondadas podem não fechar com ele, e a diferença vai em
 * `roundingDelta` (total arredondado menos soma das partes arredondadas), nunca escondida.
 */
function sumWithRoundingDelta(parts, places = 2) {
  const total = roundHalfUp(sum(parts), places);
  const rounded = parts.map((p) => roundHalfUp(p, places));
  return { total: toString(total), parts: rounded.map(toString), roundingDelta: toString(sub(total, sum(rounded))) };
}

module.exports = {
  dec, add, sub, mul, div, cmp, isZero, sum, roundHalfUp, toString, round, money, hours, count, percent, ratioResult, sumWithRoundingDelta,
};
