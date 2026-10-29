'use strict';

/**
 * M9-D672 — KPI sup.reviews (Reviews), versão 1. Fluxo no mês de São Paulo da data-base: nota média das avaliações públicas concluídas (1 a 5) = Σ nota ÷ número de
 * reviews, 2 casas, arredondada uma só vez; contagem por nota (1 a 5) e por plataforma. Menos de minSample reviews (analytics.qualidade.min_amostra) -> INCOMPLETE, valor nulo.
 * Entrada (rm_mkt_reviews): { rows: [{ platform, reviews, ratingSum, ratings: [nota1..nota5] | null }] }. Nota por nota ainda não calculada pelo read model (nula) ou que não
 * fecha com o total de reviews -> DEGRADED, valor nulo.
 */
const money = require('./money');
const { degraded, incomplete, sumCounts, byText } = require('./_legalCorKpi');

const NOTES = [1, 2, 3, 4, 5];
const average = (sum, count) => money.round(money.div(sum, count), 2);

function compute(input, params = {}) {
  const minSample = Number.isInteger(params.minSample) && params.minSample >= 1 ? params.minSample : 5;
  const rows = (input.rows || []).filter((r) => money.cmp(r.reviews || 0, 0) > 0);
  const reviews = sumCounts(rows.map((r) => r.reviews));
  if (rows.some((r) => !Array.isArray(r.ratings) || r.ratings.some((n) => n === null || n === undefined))) return degraded('READ_MODEL_NAO_RECALCULADO', { reviews });
  if (money.cmp(reviews, minSample) < 0) return incomplete('AMOSTRA_INSUFICIENTE', { reviews, minSample: String(minSample) });
  const byRating = NOTES.map((n) => sumCounts(rows.map((r) => r.ratings[n - 1])));
  if (money.cmp(sumCounts(byRating), reviews) !== 0) return degraded('NOTAS_NAO_FECHAM_COM_O_TOTAL', { reviews, rated: sumCounts(byRating) });
  const ratingSum = sumCounts(rows.map((r) => r.ratingSum));
  const platforms = [...new Set(rows.map((r) => r.platform))].sort(byText).map((platform) => {
    const own = rows.filter((r) => r.platform === platform);
    const count = sumCounts(own.map((r) => r.reviews));
    return { platform, reviews: count, average: average(sumCounts(own.map((r) => r.ratingSum)), count) };
  });
  const dimensions = [{ key: 'reviews_qtd', value: reviews }, ...NOTES.map((n) => ({ key: `nota_${n}_qtd`, value: byRating[n - 1] }))];
  for (const p of platforms) dimensions.push({ key: `plataforma:${p.platform}:reviews_qtd`, value: p.reviews }, { key: `plataforma:${p.platform}:nota_media`, value: p.average });
  return { value: average(ratingSum, reviews), status: 'OK', details: { reviews, ratingSum, minSample: String(minSample), byRating: Object.fromEntries(NOTES.map((n) => [n, byRating[n - 1]])), byPlatform: platforms }, dimensions };
}

const row = (platform, reviews, ratingSum, ratings) => ({ platform, reviews, ratingSum, ratings });
const okOf = (value, reviews, ratingSum, ratings, platforms) => ({
  value, status: 'OK', details: { reviews, ratingSum, minSample: '5', byRating: Object.fromEntries(ratings.map((c, i) => [i + 1, c])), byPlatform: platforms },
  dimensions: [{ key: 'reviews_qtd', value: reviews }, ...ratings.map((c, i) => ({ key: `nota_${i + 1}_qtd`, value: c })), ...platforms.flatMap((p) => [{ key: `plataforma:${p.platform}:reviews_qtd`, value: p.reviews }, { key: `plataforma:${p.platform}:nota_media`, value: p.average }])],
});
const bad = (status, reason, details) => ({ value: null, status, message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhum review no mês: INCOMPLETE e sem valor', params: { minSample: 5 }, input: { rows: [] }, expected: bad('INCOMPLETE', 'AMOSTRA_INSUFICIENTE', { reviews: '0', minSample: '5' }) },
  {
    kind: 'single', name: 'um review nota 5 com amostra mínima 1', params: { minSample: 1 }, input: { rows: [row('GOOGLE', 1, 5, [0, 0, 0, 0, 1])] },
    expected: { ...okOf('5.00', '1', '5', ['0', '0', '0', '0', '1'], [{ platform: 'GOOGLE', reviews: '1', average: '5.00' }]), details: { reviews: '1', ratingSum: '5', minSample: '1', byRating: { 1: '0', 2: '0', 3: '0', 4: '0', 5: '1' }, byPlatform: [{ platform: 'GOOGLE', reviews: '1', average: '5.00' }] } },
  },
  {
    kind: 'typical', name: 'exemplo da demanda: 5,5,4,4,5 dá 4,60', params: { minSample: 5 }, input: { rows: [row('GOOGLE', 5, 23, [0, 0, 0, 2, 3])] },
    expected: okOf('4.60', '5', '23', ['0', '0', '0', '2', '3'], [{ platform: 'GOOGLE', reviews: '5', average: '4.60' }]),
  },
  {
    kind: 'period_edge', name: 'quatro reviews com amostra mínima 5: INCOMPLETE e sem valor', params: { minSample: 5 }, input: { rows: [row('GOOGLE', 4, 18, [0, 0, 0, 2, 2])] },
    expected: bad('INCOMPLETE', 'AMOSTRA_INSUFICIENTE', { reviews: '4', minSample: '5' }),
  },
  {
    kind: 'rounding', name: 'média 4,625 arredonda para cima numa só vez (4,63) e junta as plataformas', params: { minSample: 5 },
    input: { rows: [row('GOOGLE', 5, 25, [0, 0, 0, 0, 5]), row('FACEBOOK', 3, 12, [0, 0, 0, 3, 0])] },
    expected: okOf('4.63', '8', '37', ['0', '0', '0', '3', '5'], [{ platform: 'FACEBOOK', reviews: '3', average: '4.00' }, { platform: 'GOOGLE', reviews: '5', average: '5.00' }]),
  },
  { kind: 'period_edge', name: 'contagem por nota ainda não calculada pelo read model: DEGRADED e sem valor', params: { minSample: 5 }, input: { rows: [row('GOOGLE', 5, 23, [null, null, null, null, null])] }, expected: bad('DEGRADED', 'READ_MODEL_NAO_RECALCULADO', { reviews: '5' }) },
  { kind: 'period_edge', name: 'notas que não fecham com o total: DEGRADED e sem valor', params: { minSample: 5 }, input: { rows: [row('GOOGLE', 5, 23, [0, 0, 0, 2, 2])] }, expected: bad('DEGRADED', 'NOTAS_NAO_FECHAM_COM_O_TOTAL', { reviews: '5', rated: '4' }) },
];

module.exports = { id: 'sup.reviews', version: 1, compute, testCases };
