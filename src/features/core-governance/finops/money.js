'use strict';

/**
 * Dinheiro sem ponto flutuante (M9-D860): tudo em BigInt. Centavos inteiros no ledger; centavos fracionários dos acúmulos em escala 1e6.
 */
const DECIMAL_RE = /^\d{1,12}(?:[.,]\d{1,6})?$/;

/** num / den arredondado half-even (empate vai ao par). Aceita sinal; den > 0. */
function divHalfEven(num, den) {
  const n = BigInt(num);
  const d = BigInt(den);
  if (d <= 0n) throw new RangeError('divisor deve ser positivo');
  const neg = n < 0n;
  const abs = neg ? -n : n;
  let q = abs / d;
  const r2 = (abs % d) * 2n;
  if (r2 > d || (r2 === d && q % 2n === 1n)) q += 1n;
  return neg ? -q : q;
}

/** "0,05" | "0.05" | 5 -> BigInt na escala 1e6 (0,05 -> 50000n). Nulo se inválido ou negativo. */
function toScaled(value) {
  const text = typeof value === 'number' ? (Number.isFinite(value) && value >= 0 ? value.toFixed(6) : '') : String(value ?? '').trim();
  if (!DECIMAL_RE.test(text)) return null;
  const [int, frac = ''] = text.replace(',', '.').split('.');
  return BigInt(int) * 1000000n + BigInt(frac.padEnd(6, '0'));
}

/** centavos na escala 1e6 -> centavos inteiros (half-even). */
const scaledToCents = (scaled) => divHalfEven(scaled, 1000000n);

/** BigInt -> Number, recusando o que não cabe com exatidão. */
function safeNumber(big) {
  const n = Number(big);
  if (!Number.isSafeInteger(n)) throw new RangeError('valor fora do intervalo inteiro seguro');
  return n;
}

/** Quantidade decimal (Number ou texto) -> BigInt na escala 1e6 por texto, sem float em dinheiro. */
const quantityScaled = (value) => toScaled(typeof value === 'bigint' ? value.toString() : value);

module.exports = { divHalfEven, toScaled, scaledToCents, safeNumber, quantityScaled };
