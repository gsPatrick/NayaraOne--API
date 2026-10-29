'use strict';

/**
 * M9-D650 — KPI obra.projected_margin (Margem projetada), versão 1. Rótulo "Projetada" (natureza PROJECTED, M9-D610). Por obra, margem = receita
 * contratada − forecast do custo (obra.baseline_actual_forecast); a empresa soma as obras. margemProjetada% = (receita − forecast) ÷ receita × 100,
 * 2 casas, a partir de valores exatos. Exemplo do livro: receita 1.200.000,00 e forecast 1.037.037,04 -> 162.962,96 e 13,58%.
 * Valor = margem da empresa em reais; dimensões: margem_pct, receita_brl, custo_projetado_brl e, por obra, a margem em reais e em %.
 * Entrada: { asOfDate, projects: [{ id, revenue, forecast }] }. Regra de qualidade: forecast INCOMPLETE em qualquer obra, ou receita contratada
 * zero (da obra ou da empresa) -> INCOMPLETE e valor nulo, nunca margem inventada.
 */
const money = require('./money');
const { incomplete, pct2, sortedById, total } = require('./_obraKpi');

const missing = (v) => v === null || v === undefined;

function compute(input) {
  const projects = sortedById(input.projects);
  if (!projects.length) return incomplete('SEM_OBRA', { projects: '0' });
  if (projects.some((p) => missing(p.forecast))) return incomplete('FORECAST_INCOMPLETO', { projects: String(projects.length) });
  if (projects.some((p) => missing(p.revenue) || money.cmp(p.revenue, 0) <= 0)) return incomplete('RECEITA_CONTRATADA_ZERO', { projects: String(projects.length) });
  const revenue = total(projects, (p) => p.revenue);
  const cost = total(projects, (p) => p.forecast);
  const margin = money.sub(revenue, cost);
  const dimensions = [
    { key: 'margem_pct', value: pct2(margin, revenue) }, { key: 'receita_brl', value: money.money(revenue) }, { key: 'custo_projetado_brl', value: money.money(cost) },
  ];
  for (const p of projects) {
    const m = money.sub(p.revenue, p.forecast);
    dimensions.push({ key: `obra:${p.id}`, value: money.money(m) }, { key: `obra:${p.id}:margem_pct`, value: pct2(m, p.revenue) });
  }
  return { value: money.money(margin), status: 'OK', details: { projects: String(projects.length), marginPct: dimensions[0].value, revenueBrl: dimensions[1].value, projectedCostBrl: dimensions[2].value }, dimensions };
}

const project = (id, revenue, forecast) => ({ id, revenue, forecast });
const input = (projects) => ({ asOfDate: '2026-10-28', projects });
const ok = (margin, pct, revenue, cost, projects, per) => ({
  value: margin, status: 'OK', details: { projects, marginPct: pct, revenueBrl: revenue, projectedCostBrl: cost },
  dimensions: [{ key: 'margem_pct', value: pct }, { key: 'receita_brl', value: revenue }, { key: 'custo_projetado_brl', value: cost }, ...per.flatMap(([id, m, p]) => [{ key: `obra:${id}`, value: m }, { key: `obra:${id}:margem_pct`, value: p }])],
});
const none = (reason, projects) => ({ value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason, projects }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhuma obra: INCOMPLETE e sem valor', input: input([]), expected: none('SEM_OBRA', '0') },
  { kind: 'single', name: 'obra sem lucro nem prejuízo: margem zero', input: input([project('a', '100.00', '100.00')]), expected: ok('0.00', '0.00', '100.00', '100.00', '1', [['a', '0.00', '0.00']]) },
  {
    kind: 'typical', name: 'exemplo do livro: receita 1.200.000,00 e forecast 1.037.037,04 dão 162.962,96 e 13,58%', input: input([project('a', '1200000.00', '1037037.04')]),
    expected: ok('162962.96', '13.58', '1200000.00', '1037037.04', '1', [['a', '162962.96', '13.58']]),
  },
  { kind: 'period_edge', name: 'forecast INCOMPLETE em uma obra: a margem fica INCOMPLETE', input: input([project('a', '100.00', null)]), expected: none('FORECAST_INCOMPLETO', '1') },
  { kind: 'period_edge', name: 'receita contratada zero: INCOMPLETE', input: input([project('a', '0.00', '50.00')]), expected: none('RECEITA_CONTRATADA_ZERO', '1') },
  { kind: 'rounding', name: 'o percentual arredonda uma vez, meio para cima (0,005% vira 0,01%)', input: input([project('a', '200.00', '199.99')]), expected: ok('0.01', '0.01', '200.00', '199.99', '1', [['a', '0.01', '0.01']]) },
  { kind: 'typical', name: 'margem negativa quando o forecast passa da receita', input: input([project('a', '100.00', '125.00')]), expected: ok('-25.00', '-25.00', '100.00', '125.00', '1', [['a', '-25.00', '-25.00']]) },
];

module.exports = { id: 'obra.projected_margin', version: 1, compute, testCases };
