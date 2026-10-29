'use strict';

/**
 * M9-D610 (3.2) — série com mais de uma natureza (ex.: baseline x realizado x forecast) vira uma lista de séries, uma por natureza,
 * na ordem fixa realizado, previsto, estimado, projetado. Os pontos de naturezas diferentes nunca são somados: o total de cada série
 * soma só a própria natureza (aritmética decimal exata de formulas/money.js).
 */
const AppError = require('../../../utils/AppError');
const money = require('./formulas/money');
const { VALUE_NATURES, NATURE_LABELS } = require('./registry.natures');

/** points: [{ valueNature, key, value }] com value em texto decimal. Devolve [{ valueNature, label, points, total }]. */
function buildSeriesByNature(points) {
  if (!Array.isArray(points)) throw AppError.badRequest('Informe a lista de pontos da série.', 'ANALYTICS_SERIES_INVALID');
  const groups = new Map(VALUE_NATURES.map((n) => [n, []]));
  for (const p of points) {
    if (!p || !groups.has(p.valueNature)) {
      throw AppError.badRequest(`Cada ponto precisa de uma natureza válida: ${VALUE_NATURES.join(', ')}.`, 'ANALYTICS_SERIES_INVALID');
    }
    groups.get(p.valueNature).push({ key: p.key, value: String(p.value) });
  }
  return VALUE_NATURES.filter((n) => groups.get(n).length).map((n) => ({
    valueNature: n,
    label: NATURE_LABELS[n],
    points: groups.get(n),
    total: money.toString(money.sum(groups.get(n).map((p) => p.value))),
  }));
}

module.exports = { buildSeriesByNature };
