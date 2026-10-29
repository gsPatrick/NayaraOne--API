'use strict';

// Confiança (Caderno §10): SINAL auxiliar, calculado só de relevância das fontes e cobertura das afirmações. Nenhum código do
// sistema decide aprovação, ação ou pulo de verificação a partir dela (teste m9d025_confidence_nao_libera_acao).

const decimal = require('../../../analytics/metrics/formulas/money');

const fixed = (n) => Number(n).toFixed(4);

/**
 * peso x média de relevância + (1 - peso) x cobertura (afirmações aceitas / afirmações), em decimal exato, 4 casas meio para cima.
 * Sem afirmação a cobertura é 1; sem fonte citada a relevância é 0.
 */
function computeConfidence({ relevances, claims, accepted, weight }) {
  const mean = relevances.length ? decimal.div(decimal.sum(relevances.map(fixed)), relevances.length) : decimal.dec(0);
  const coverage = claims > 0 ? decimal.div(accepted, claims) : decimal.dec(1);
  const w = decimal.dec(fixed(weight));
  const total = decimal.add(decimal.mul(w, mean), decimal.mul(decimal.sub(1, w), coverage));
  return decimal.round(total, 4);
}

/** Texto exibido ao usuário: sempre como estimativa. */
function displayConfidence(confidence) {
  return `confiança estimada: ${String(confidence).replace('.', ',')}`;
}

module.exports = { computeConfidence, displayConfidence };
