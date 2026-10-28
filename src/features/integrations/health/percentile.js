'use strict';

/**
 * Percentil por interpolação linear entre os dois valores vizinhos (M9-D206). `sorted` já vem em ordem crescente.
 * Exemplo do livro: 100..1000 ms em 10 chamadas dão p50 = 550, p95 = 955 e p99 = 991. Devolve inteiro (ms).
 */
function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return Math.round(sorted[0]);
  const rank = ((n - 1) * p) / 100;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo));
}

module.exports = { percentile };
