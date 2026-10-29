'use strict';

/**
 * M9-D650 — KPI obra.progress_vs_schedule (Progresso x cronograma), versão 1. Posição no fim do dia-base. Cada obra traz o planejado (baseline) e o
 * realizado (actual) em %, já ponderados pelo peso das etapas no read model (rm_project_progress, M9-D618); a empresa é a média das obras ponderada
 * pelo peso da obra (orçamento aprovado; obra sem orçamento pesa 1, a mesma regra de "etapa sem peso usa peso 1" do livro).
 * Valor = realizado% da empresa (PERCENT); dimensões: planejado_pct, desvio_pp (realizado − planejado, negativo é atraso) e as três por obra.
 * Entrada: { asOfDate, projects: [{ id, baseline, actual, weight }] }. Regra de qualidade: obra sem cronograma baseline (sem planejado ou sem
 * realizado) -> INCOMPLETE e valor nulo. Planejado, realizado e desvio saem de valores exatos, arredondados uma só vez (meio para cima, 2 casas).
 */
const money = require('./money');
const { incomplete, sortedById, total } = require('./_obraKpi');

const weightOf = (p) => (p.weight !== null && p.weight !== undefined && money.cmp(p.weight, 0) > 0 ? p.weight : '1');
const weighted = (list, field, w) => money.div(total(list, (p) => money.mul(weightOf(p), p[field])), w);

function compute(input) {
  const projects = sortedById(input.projects);
  const without = projects.filter((p) => p.baseline === null || p.baseline === undefined || p.actual === null || p.actual === undefined);
  if (!projects.length) return incomplete('SEM_OBRA', { projects: '0', projectsWithoutBaseline: '0' });
  if (without.length) return incomplete('OBRA_SEM_CRONOGRAMA_BASELINE', { projects: String(projects.length), projectsWithoutBaseline: String(without.length) });
  const weight = total(projects, weightOf);
  const planned = weighted(projects, 'baseline', weight);
  const actual = weighted(projects, 'actual', weight);
  const dimensions = [
    { key: 'planejado_pct', value: money.round(planned, 2) },
    { key: 'desvio_pp', value: money.round(money.sub(actual, planned), 2) },
  ];
  for (const p of projects) {
    dimensions.push(
      { key: `obra:${p.id}:realizado_pct`, value: money.round(p.actual, 2) },
      { key: `obra:${p.id}:planejado_pct`, value: money.round(p.baseline, 2) },
      { key: `obra:${p.id}:desvio_pp`, value: money.round(money.sub(p.actual, p.baseline), 2) }
    );
  }
  return {
    value: money.round(actual, 2),
    status: 'OK',
    details: { baselinePercent: dimensions[0].value, actualPercent: money.round(actual, 2), deviationPp: dimensions[1].value, projects: String(projects.length) },
    dimensions,
  };
}

const project = (id, baseline, actual, weight) => ({ id, baseline, actual, weight });
const input = (projects) => ({ asOfDate: '2026-10-28', projects });
const one = (id, p, a) => [
  { key: `obra:${id}:realizado_pct`, value: a }, { key: `obra:${id}:planejado_pct`, value: p }, { key: `obra:${id}:desvio_pp`, value: money.round(money.sub(a, p), 2) },
];
const ok = (planned, actual, deviation, projects, dims) => ({
  value: actual, status: 'OK', details: { baselinePercent: planned, actualPercent: actual, deviationPp: deviation, projects },
  dimensions: [{ key: 'planejado_pct', value: planned }, { key: 'desvio_pp', value: deviation }, ...dims],
});

const testCases = [
  { kind: 'empty', name: 'nenhuma obra: INCOMPLETE e sem valor', input: input([]), expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'SEM_OBRA', projects: '0', projectsWithoutBaseline: '0' }, dimensions: [] } },
  { kind: 'single', name: 'uma obra sem peso informado pesa 1', input: input([project('a', '10.000000', '10.000000', null)]), expected: ok('10.00', '10.00', '0.00', '1', one('a', '10.00', '10.00')) },
  { kind: 'typical', name: 'exemplo do livro: planejado 62,00%, realizado 54,00%, desvio -8,00 p.p.', input: input([project('a', '62.000000', '54.000000', '980000.00')]), expected: ok('62.00', '54.00', '-8.00', '1', one('a', '62.00', '54.00')) },
  {
    kind: 'period_edge', name: 'obra sem cronograma baseline: INCOMPLETE e sem valor', input: input([project('a', null, null, '1.00'), project('b', '50.000000', '40.000000', '1.00')]),
    expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'OBRA_SEM_CRONOGRAMA_BASELINE', projects: '2', projectsWithoutBaseline: '1' }, dimensions: [] },
  },
  {
    kind: 'rounding', name: 'o desvio sai do valor exato e arredonda uma vez (-9,995 vira -10,00, não -9,99)', input: input([project('a', '10.000000', '0.000000', '1.00'), project('b', '10.000000', '0.010000', '1.00')]),
    expected: ok('10.00', '0.01', '-10.00', '2', [...one('a', '10.00', '0.00'), ...one('b', '10.00', '0.01')]),
  },
  { kind: 'typical', name: 'duas obras: a média é ponderada pelo orçamento (980 mil e 100 mil)', input: input([project('a', '62.000000', '54.000000', '980000.00'), project('b', '60.000000', '50.000000', '100000.00')]), expected: ok('61.81', '53.63', '-8.19', '2', [...one('a', '62.00', '54.00'), ...one('b', '60.00', '50.00')]) },
];

module.exports = { id: 'obra.progress_vs_schedule', version: 1, compute, testCases };
