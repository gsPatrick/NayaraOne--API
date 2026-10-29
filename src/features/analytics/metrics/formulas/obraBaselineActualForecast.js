'use strict';

/**
 * M9-D650 — KPI obra.baseline_actual_forecast (Baseline, actual e forecast do custo), versão 1. Três séries que NUNCA se somam entre si (BI-006,
 * M9-D610): baseline = orçamento de custo aprovado (PLANNED), actual = saídas liquidadas da obra até o fim do dia-base (ACTUAL) e forecast =
 * actual + custoAFazer × fatorDesvio (PROJECTED). A projeção de cada obra vem pronta do read model rm_project_cost (M9-D618, DI-D618-3), que a
 * calcula em decimal exato: custoAFazer = max(0, baseline × (1 − realizado%/100)); fatorDesvio = max(1, actual ÷ (baseline × realizado%/100)) quando
 * realizado% > 0 e 1 quando realizado% = 0. Exemplo do livro: baseline 980.000,00, realizado 54%, actual 560.000,00 -> desvio 560.000 ÷ 529.200
 * (sem arredondar no meio da conta), custoAFazer 477.037,04, forecast 1.037.037,04.
 * Valor = forecast da empresa (soma dos forecasts das obras); dimensões: baseline_brl, actual_brl, forecast_brl e as três por obra.
 * Entrada: { asOfDate, projects: [{ id, budget, actual, forecast, percent }] }. Regra de qualidade: forecast sem progresso medido (ou sem
 * orçamento) -> INCOMPLETE e valor nulo.
 */
const money = require('./money');
const { incomplete, sortedById, total } = require('./_obraKpi');

const missing = (v) => v === null || v === undefined;

function compute(input) {
  const projects = sortedById(input.projects);
  if (!projects.length) return incomplete('SEM_OBRA', { projects: '0', projectsWithoutForecast: '0' });
  const without = projects.filter((p) => missing(p.forecast));
  if (without.length) {
    const reason = without.some((p) => missing(p.budget)) ? 'ORCAMENTO_AUSENTE' : 'FORECAST_SEM_PROGRESSO_MEDIDO';
    return incomplete(reason, { projects: String(projects.length), projectsWithoutForecast: String(without.length) });
  }
  const baseline = money.money(total(projects, (p) => p.budget));
  const actual = money.money(total(projects, (p) => p.actual));
  const forecast = money.money(total(projects, (p) => p.forecast));
  const dimensions = [{ key: 'baseline_brl', value: baseline }, { key: 'actual_brl', value: actual }, { key: 'forecast_brl', value: forecast }];
  for (const p of projects) {
    dimensions.push(
      { key: `obra:${p.id}:baseline_brl`, value: money.money(p.budget) },
      { key: `obra:${p.id}:actual_brl`, value: money.money(p.actual) },
      { key: `obra:${p.id}:forecast_brl`, value: money.money(p.forecast) }
    );
  }
  return {
    value: forecast,
    status: 'OK',
    details: {
      projects: String(projects.length), baselineBrl: baseline, actualBrl: actual, forecastBrl: forecast,
      series: [{ valueNature: 'PLANNED', key: 'baseline_brl', value: baseline }, { valueNature: 'ACTUAL', key: 'actual_brl', value: actual }, { valueNature: 'PROJECTED', key: 'forecast_brl', value: forecast }],
    },
    dimensions,
  };
}

const project = (id, budget, actual, forecast, percent) => ({ id, budget, actual, forecast, percent });
const input = (projects) => ({ asOfDate: '2026-10-28', projects });
const series = (b, a, f) => [{ valueNature: 'PLANNED', key: 'baseline_brl', value: b }, { valueNature: 'ACTUAL', key: 'actual_brl', value: a }, { valueNature: 'PROJECTED', key: 'forecast_brl', value: f }];
const dims = (b, a, f, per) => [{ key: 'baseline_brl', value: b }, { key: 'actual_brl', value: a }, { key: 'forecast_brl', value: f }, ...per.flatMap(([id, pb, pa, pf]) => [
  { key: `obra:${id}:baseline_brl`, value: pb }, { key: `obra:${id}:actual_brl`, value: pa }, { key: `obra:${id}:forecast_brl`, value: pf },
])];
const ok = (b, a, f, projects, per) => ({ value: f, status: 'OK', details: { projects, baselineBrl: b, actualBrl: a, forecastBrl: f, series: series(b, a, f) }, dimensions: dims(b, a, f, per) });
const none = (reason, projects, withoutForecast) => ({ value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason, projects, projectsWithoutForecast: withoutForecast }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhuma obra: INCOMPLETE e sem valor', input: input([]), expected: none('SEM_OBRA', '0', '0') },
  { kind: 'single', name: 'uma obra no orçamento: forecast igual ao orçamento', input: input([project('a', '100.00', '0.00', '100.00', '0.000000')]), expected: ok('100.00', '0.00', '100.00', '1', [['a', '100.00', '0.00', '100.00']]) },
  {
    kind: 'typical', name: 'exemplo do livro: baseline 980.000,00, actual 560.000,00, forecast 1.037.037,04 em três séries separadas',
    input: input([project('a', '980000.00', '560000.00', '1037037.04', '54.000000')]), expected: ok('980000.00', '560000.00', '1037037.04', '1', [['a', '980000.00', '560000.00', '1037037.04']]),
  },
  { kind: 'period_edge', name: 'obra sem progresso medido: forecast nulo deixa o KPI INCOMPLETE', input: input([project('a', '100.00', '0.00', null, null)]), expected: none('FORECAST_SEM_PROGRESSO_MEDIDO', '1', '1') },
  { kind: 'period_edge', name: 'obra sem orçamento: INCOMPLETE por orçamento ausente', input: input([project('a', null, '10.00', null, '10.000000')]), expected: none('ORCAMENTO_AUSENTE', '1', '1') },
  {
    kind: 'rounding', name: 'o total arredonda uma só vez (10,005 + 10,005 = 20,01, não 20,02)', input: input([project('a', '1.00', '1.00', '10.005', '1.000000'), project('b', '1.00', '1.00', '10.005', '1.000000')]),
    expected: ok('2.00', '2.00', '20.01', '2', [['a', '1.00', '1.00', '10.01'], ['b', '1.00', '1.00', '10.01']]),
  },
];

module.exports = { id: 'obra.baseline_actual_forecast', version: 1, compute, testCases };
