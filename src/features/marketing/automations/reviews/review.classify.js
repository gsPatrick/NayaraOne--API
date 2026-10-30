'use strict';

/** Nota inteira de 1 a 5 (a escala única da satisfação, a mesma do BI). Qualquer outra coisa é inválida. */
const parseScore = (value) => {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};

/**
 * Classificação por parâmetros: positiva a partir de `minPositive`, negativa até `maxNegative`; a nota entre as duas não tem ação (NEUTRAL). A configuração garante
 * maxNegative < minPositive, então as faixas nunca se sobrepõem; se mesmo assim se sobrepuserem, a nota é tratada como negativa (o lado seguro: nunca pedir avaliação).
 */
function classify(score, { minPositive, maxNegative }) {
  const n = parseScore(score);
  if (n === null) return 'INVALID';
  if (n <= maxNegative) return 'NEGATIVE';
  if (n >= minPositive) return 'POSITIVE';
  return 'NEUTRAL';
}

module.exports = { classify, parseScore };
