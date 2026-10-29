'use strict';

/**
 * M9-D622 — KPI fin.breathing_need (Necessidade para respirar), versão 1. Posição no fim do dia-base, em reais com 2 casas, arredondada uma vez:
 *   necessidade = max(0, contasAPagarVencidas + fin.payables_30d + comissõesAPagarAtéHoje+29SemLançamento − fin.free_cash)
 * Dinheiro de terceiros fica de fora (as pontas já o excluem). Se o caixa livre cobre tudo o valor é 0,00 e o texto da tela é "Sem necessidade no horizonte".
 * Entrada: { components: { overduePayables, payables30d, freeCash: { value, status }, commissions: { value } } } já calculados pelas fórmulas de cada componente.
 * Regra de qualidade (herança): qualquer componente (caixa livre, contas a pagar em 30 dias, contas vencidas) que não esteja OK deixa o KPI DEGRADED e sem valor.
 * Dimensões: o valor de cada componente e o déficit bruto (antes do max com zero), para a tela explicar a conta.
 */
const money = require('./money');
const { degraded } = require('./_finKpi');

const TEXT_NONE = 'Sem necessidade no horizonte';
const INHERITED = Object.freeze(['freeCash', 'payables30d', 'overduePayables']);
const CODE_OF = Object.freeze({ freeCash: 'fin.free_cash', payables30d: 'fin.payables_30d', overduePayables: 'fin.overdue_payables' });

function compute(input) {
  const c = input.components || {};
  const bad = INHERITED.filter((k) => !c[k] || c[k].status !== 'OK' || c[k].value === null || c[k].value === undefined);
  if (bad.length) return degraded('COMPONENTE_DEGRADADO', { degradedComponents: bad.map((k) => ({ metricCode: CODE_OF[k], status: (c[k] && c[k].status) || 'DEGRADED' })) });
  const gross = money.sub(money.sum([c.overduePayables.value, c.payables30d.value, c.commissions.value]), c.freeCash.value);
  const value = money.cmp(gross, 0) > 0 ? money.money(gross) : money.money(0);
  const dimensions = [
    { key: 'vencido_a_pagar_brl', value: money.money(c.overduePayables.value) }, { key: 'a_pagar_30d_brl', value: money.money(c.payables30d.value) },
    { key: 'comissoes_brl', value: money.money(c.commissions.value) }, { key: 'caixa_livre_brl', value: money.money(c.freeCash.value) },
    { key: 'deficit_bruto_brl', value: money.money(gross) },
  ];
  return { value, status: 'OK', details: money.isZero(value) ? { text: TEXT_NONE } : {}, dimensions };
}

const ok = (value) => ({ value, status: 'OK' });
const comp = (overdue, p30, commissions, cash) => ({ components: { overduePayables: ok(overdue), payables30d: ok(p30), commissions: { value: commissions }, freeCash: ok(cash) } });
const dimsOf = (o, p, m, f, g) => [
  { key: 'vencido_a_pagar_brl', value: o }, { key: 'a_pagar_30d_brl', value: p }, { key: 'comissoes_brl', value: m }, { key: 'caixa_livre_brl', value: f }, { key: 'deficit_bruto_brl', value: g },
];
const none = { text: TEXT_NONE };
const lost = 'Dado incompleto, valor não confiável.';

const testCases = [
  { kind: 'empty', name: 'nada a pagar e caixa zero: 0,00 e "Sem necessidade no horizonte"', input: comp('0.00', '0.00', '0.00', '0.00'), expected: { value: '0.00', status: 'OK', details: none, dimensions: dimsOf('0.00', '0.00', '0.00', '0.00', '0.00') } },
  { kind: 'single', name: 'só uma conta vencida de 100,00 e caixa zero: necessidade 100,00', input: comp('100.00', '0.00', '0.00', '0.00'), expected: { value: '100.00', status: 'OK', details: {}, dimensions: dimsOf('100.00', '0.00', '0.00', '0.00', '100.00') } },
  {
    kind: 'typical', name: 'exemplo do livro: vencido 6.500,00 + 22.000,00 + comissões 3.000,00 − caixa livre 18.000,00 = 13.500,00', input: comp('6500.00', '22000.00', '3000.00', '18000.00'),
    expected: { value: '13500.00', status: 'OK', details: {}, dimensions: dimsOf('6500.00', '22000.00', '3000.00', '18000.00', '13500.00') },
  },
  {
    kind: 'period_edge', name: 'caixa livre de 40.000,00 cobre tudo: 0,00 (nunca negativo) e o déficit bruto negativo fica nas dimensões', input: comp('6500.00', '22000.00', '3000.00', '40000.00'),
    expected: { value: '0.00', status: 'OK', details: none, dimensions: dimsOf('6500.00', '22000.00', '3000.00', '40000.00', '-8500.00') },
  },
  {
    kind: 'rounding', name: 'centavos exatos e arredondamento uma só vez (meio para cima)', input: comp('0.004', '0.004', '0.00', '0.00'),
    expected: { value: '0.01', status: 'OK', details: {}, dimensions: dimsOf('0.00', '0.00', '0.00', '0.00', '0.01') },
  },
  {
    kind: 'period_edge', name: 'caixa livre DEGRADED: o KPI herda, DEGRADED e sem valor', input: { components: { ...comp('1.00', '1.00', '1.00', '0.00').components, freeCash: { value: null, status: 'DEGRADED' } } },
    expected: { value: null, status: 'DEGRADED', message: lost, details: { reason: 'COMPONENTE_DEGRADADO', degradedComponents: [{ metricCode: 'fin.free_cash', status: 'DEGRADED' }] }, dimensions: [] },
  },
  {
    kind: 'period_edge', name: 'contas a pagar em 30 dias e vencidas INCOMPLETE: o KPI herda e lista os dois componentes',
    input: { components: { overduePayables: { value: null, status: 'INCOMPLETE' }, payables30d: { value: null, status: 'INCOMPLETE' }, commissions: { value: '0.00' }, freeCash: ok('5.00') } },
    expected: {
      value: null, status: 'DEGRADED', message: lost, dimensions: [],
      details: { reason: 'COMPONENTE_DEGRADADO', degradedComponents: [{ metricCode: 'fin.payables_30d', status: 'INCOMPLETE' }, { metricCode: 'fin.overdue_payables', status: 'INCOMPLETE' }] },
    },
  },
];

module.exports = { id: 'fin.breathing_need', version: 1, compute, testCases };
