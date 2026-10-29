'use strict';

/** Aritmética de dinheiro em centavos inteiros (BigInt): sem ponto flutuante nas somas, diferenças e percentuais exibidos. */
const toCents = (value) => BigInt(Math.round(Number(value || 0) * 100));

function centsText(cents) {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** Percentual (duas casas, meio para cima) de `part` sobre `base`, em texto; null sem base. */
function pctText(part, base) {
  if (base === 0n) return null;
  const neg = (part < 0n) !== (base < 0n) && part !== 0n;
  const p = part < 0n ? -part : part;
  const b = base < 0n ? -base : base;
  const hundredths = (2n * p * 10000n + b) / (2n * b);
  return `${neg ? '-' : ''}${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
}

module.exports = { toCents, centsText, pctText };
