'use strict';

/**
 * M9-D710 — KPI crm.opportunities_won (Oportunidades ganhas na janela), versão 1. Contagem de oportunidades que entraram no estágio ganho dentro da janela móvel (analytics.centro.janela_horas)
 * e soma do valor da proposta aceita em BRL; oportunidade ganha sem proposta aceita tem valor nulo na linha, conta e entra em details.withoutValue. Original e compensatória (ganho desfeito)
 * somam zero. Entrada (rm_command_events, kind OPPORTUNITY_WON): { rows: [{ broker, origin, count, amount, withoutValue }], previous: { count, amount }, undated }. Dimensões: corretor e origem.
 * Regra de qualidade: ganho sem data -> INCOMPLETE, valor nulo.
 */
const money = require('./money');
const { totalsOf, previousOf, groupBy, dimensionsOf, windowDimensions, undatedResult, hasUndated } = require('./_commandKpi');

function compute(input) {
  if (hasUndated(input)) return undatedResult('OPORTUNIDADE_GANHA_SEM_DATA', input.undated);
  const rows = input.rows || [];
  const total = totalsOf(rows);
  const previous = previousOf(input.previous);
  const withoutValue = money.count(money.sum(rows.map((r) => r.withoutValue || 0)));
  const byBroker = groupBy(rows, (r) => r.broker || 'SEM_CORRETOR');
  const byOrigin = groupBy(rows, (r) => r.origin || 'SEM_ORIGEM');
  return {
    value: total.count, status: 'OK',
    details: {
      count: total.count, amount: total.amount, withoutValue, previous,
      byBroker: byBroker.map((g) => ({ broker: g.key, count: g.count, amount: g.amount })), byOrigin: byOrigin.map((g) => ({ origin: g.key, count: g.count, amount: g.amount })),
    },
    dimensions: [...windowDimensions(total, previous), { key: 'sem_valor_qtd', value: withoutValue }, ...dimensionsOf('corretor', byBroker), ...dimensionsOf('origem', byOrigin)],
  };
}

const row = (broker, origin, count, amount, withoutValue = 0) => ({ broker, origin, count, amount, withoutValue });
const none = { count: '0', amount: '0.00' };
const grp = (name, key, count, amount) => ({ [name]: key, count, amount });
const okOf = (count, amount, withoutValue, previous, byBroker, byOrigin) => ({
  value: count, status: 'OK', details: { count, amount, withoutValue, previous, byBroker, byOrigin },
  dimensions: [{ key: 'valor_brl', value: amount }, { key: 'anterior_qtd', value: previous.count }, { key: 'anterior_valor_brl', value: previous.amount }, { key: 'sem_valor_qtd', value: withoutValue },
    ...byBroker.flatMap((g) => [{ key: `corretor:${g.broker}:qtd`, value: g.count }, { key: `corretor:${g.broker}:valor_brl`, value: g.amount }]),
    ...byOrigin.flatMap((g) => [{ key: `origem:${g.origin}:qtd`, value: g.count }, { key: `origem:${g.origin}:valor_brl`, value: g.amount }])],
});

const testCases = [
  { kind: 'empty', name: 'nenhuma oportunidade ganha: zero', input: { rows: [], previous: none, undated: 0 }, expected: okOf('0', '0.00', '0', none, [], []) },
  {
    kind: 'single', name: 'uma ganha com proposta', input: { rows: [row('b1', 'SITE', 1, '300000.00')], previous: none, undated: 0 },
    expected: okOf('1', '300000.00', '0', none, [grp('broker', 'b1', '1', '300000.00')], [grp('origin', 'SITE', '1', '300000.00')]),
  },
  {
    kind: 'typical', name: 'exemplo da demanda: 3 ganhas (300.000,00, 210.000,00 e sem proposta) = 3, 510.000,00 e withoutValue 1',
    input: { rows: [row('b1', 'SITE', 1, '300000.00'), row('b1', 'INDICACAO', 1, '210000.00'), row('b2', 'SITE', 1, null, 1)], previous: { count: 2, amount: '100.00' }, undated: 0 },
    expected: okOf('3', '510000.00', '1', { count: '2', amount: '100.00' }, [grp('broker', 'b1', '2', '510000.00'), grp('broker', 'b2', '1', '0.00')],
      [grp('origin', 'INDICACAO', '1', '210000.00'), grp('origin', 'SITE', '2', '300000.00')]),
  },
  {
    kind: 'period_edge', name: 'ganho desfeito (original + compensatória) soma zero', input: { rows: [row('b1', 'SITE', 0, '0.00')], previous: none, undated: 0 },
    expected: okOf('0', '0.00', '0', none, [grp('broker', 'b1', '0', '0.00')], [grp('origin', 'SITE', '0', '0.00')]),
  },
  {
    kind: 'rounding', name: 'valores com mais de duas casas arredondam uma só vez, meio para cima', input: { rows: [row('b1', 'SITE', 1, '0.005')], previous: none, undated: 0 },
    expected: okOf('1', '0.01', '0', none, [grp('broker', 'b1', '1', '0.01')], [grp('origin', 'SITE', '1', '0.01')]),
  },
  { kind: 'period_edge', name: 'ganho sem data: INCOMPLETE e sem valor', input: { rows: [], previous: none, undated: 2 }, expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'OPORTUNIDADE_GANHA_SEM_DATA', undated: '2' }, dimensions: [] } },
];

module.exports = { id: 'crm.opportunities_won', version: 1, compute, testCases };
