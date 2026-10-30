'use strict';

/** Centavos inteiros -> "R$ 1.500,00" (só exibição; o cálculo é sempre em centavos). */
function brl(cents) {
  const n = BigInt(cents);
  const abs = n < 0n ? -n : n;
  const reais = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0n ? '-' : ''}R$ ${reais},${String(abs % 100n).padStart(2, '0')}`;
}

module.exports = { brl };
