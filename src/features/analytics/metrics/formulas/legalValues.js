'use strict';

/**
 * M9-D660 — KPI legal.values (Valores estimados e confirmados), versão 1. Posição no fim do dia-base com DUAS séries que nunca se somam (M9-D610):
 * estimado (ESTIMATED) = soma do valor estimado dos processos ativos, que é o valor do indicador; confirmado (ACTUAL) = soma de condenações, acordos
 * ou perdas já confirmados (dimensão confirmado_brl). Processo ativo sem valor estimado NÃO é tratado como zero: é contado em details.withoutValue.
 * Entrada (rm_legal_values): { rows: [{ type, risk, estimated, confirmed, withoutValue }] }. Dinheiro em decimal exato, arredondado uma só vez.
 */
const money = require('./money');
const { buildSeriesByNature } = require('../series.byNature');
const { sumCounts, byText } = require('./_legalCorKpi');

function compute(input) {
  const rows = input.rows || [];
  const estimated = money.money(money.sum(rows.map((r) => r.estimated || 0)));
  const confirmed = money.money(money.sum(rows.map((r) => r.confirmed || 0)));
  const withoutValue = sumCounts(rows.map((r) => r.withoutValue));
  const types = [...new Set(rows.map((r) => r.type))].sort(byText);
  const dimensions = [{ key: 'confirmado_brl', value: confirmed }, { key: 'sem_valor_qtd', value: withoutValue }];
  for (const type of types) {
    const own = rows.filter((r) => r.type === type);
    dimensions.push({ key: `tipo:${type}:estimado_brl`, value: money.money(money.sum(own.map((r) => r.estimated || 0))) }, { key: `tipo:${type}:confirmado_brl`, value: money.money(money.sum(own.map((r) => r.confirmed || 0))) });
  }
  const series = buildSeriesByNature([{ valueNature: 'ESTIMATED', key: 'estimado', value: estimated }, { valueNature: 'ACTUAL', key: 'confirmado', value: confirmed }]);
  return { value: estimated, status: 'OK', details: { withoutValue, series }, dimensions };
}

const row = (type, risk, estimated, confirmed, withoutValue = 0) => ({ type, risk, estimated, confirmed, withoutValue });
const series = (est, conf) => [
  { valueNature: 'ACTUAL', label: 'Realizado', points: [{ key: 'confirmado', value: conf }], total: conf },
  { valueNature: 'ESTIMATED', label: 'Estimado', points: [{ key: 'estimado', value: est }], total: est },
];
const okOf = (est, conf, without, types) => ({
  value: est, status: 'OK', details: { withoutValue: without, series: series(est, conf) },
  dimensions: [{ key: 'confirmado_brl', value: conf }, { key: 'sem_valor_qtd', value: without }, ...types.flatMap(([t, e, c]) => [{ key: `tipo:${t}:estimado_brl`, value: e }, { key: `tipo:${t}:confirmado_brl`, value: c }])],
});

const testCases = [
  { kind: 'empty', name: 'nenhum processo: estimado e confirmado zero (não nulos)', input: { rows: [] }, expected: okOf('0.00', '0.00', '0', []) },
  { kind: 'single', name: 'um processo com estimado e sem confirmado', input: { rows: [row('LABOR', 'HIGH', '1000.50', '0')] }, expected: okOf('1000.50', '0.00', '0', [['LABOR', '1000.50', '0.00']]) },
  {
    kind: 'typical', name: 'exemplo da demanda: estimado 450.000,00 e confirmado 120.000,00 saem separados, sem total', input: { rows: [row('EVICTION', 'HIGH', '300000.00', '120000.00', 1), row('LABOR', 'LOW', '150000.00', '0', 2)] },
    expected: okOf('450000.00', '120000.00', '3', [['EVICTION', '300000.00', '120000.00'], ['LABOR', '150000.00', '0.00']]),
  },
  { kind: 'period_edge', name: 'só confirmado (processo encerrado): estimado zero e confirmado preservado', input: { rows: [row('LABOR', 'LOW', '0', '7000.00')] }, expected: okOf('0.00', '7000.00', '0', [['LABOR', '0.00', '7000.00']]) },
  {
    kind: 'rounding', name: 'centavos somam exatos: 0,10 + 0,20 = 0,30 e a quinta casa arredonda para cima uma vez', input: { rows: [row('A', 'X', '0.10', '0.00005'), row('A', 'Y', '0.20', '0')] },
    expected: okOf('0.30', '0.00', '0', [['A', '0.30', '0.00']]),
  },
];

module.exports = { id: 'legal.values', version: 1, compute, testCases };
