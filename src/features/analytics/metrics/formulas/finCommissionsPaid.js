'use strict';

/**
 * M9-D623 — KPI fin.commissions_paid (Comissões pagas), versão 1. Σ das parcelas de comissão quitadas (PAID) com data de pagamento, no calendário de
 * São Paulo, dentro do mês da data-base; natureza ACTUAL. Entrada (rm_finance_health): { asOfDate, total, count, byBroker: { corretor: valor },
 * withoutBroker: { count, amount }, withoutEntry: { count, amount } }. Regra de qualidade: parcela paga sem lançamento liquidado correspondente deixa
 * o KPI DEGRADED e sem valor (o pagamento pode não ter saído do caixa). Dinheiro em decimal exato, arredondado uma só vez (M9-D605).
 */
const money = require('./money');
const { degraded } = require('./_finKpi');

const keys = (map) => Object.keys(map || {}).sort();

function compute(input) {
  const byBroker = input.byBroker || {};
  const orphan = input.withoutBroker || { count: 0, amount: '0' };
  const unlinked = input.withoutEntry || { count: 0, amount: '0' };
  const dimensions = [
    ...keys(byBroker).map((k) => ({ key: `corretor:${k}`, value: money.money(byBroker[k]) })),
    { key: `mes:${String(input.asOfDate).slice(0, 7)}`, value: money.money(input.total) },
    { key: 'sem_corretor_brl', value: money.money(orphan.amount) },
    { key: 'sem_lancamento_brl', value: money.money(unlinked.amount) }, { key: 'sem_lancamento_qtd', value: money.count(unlinked.count) },
  ];
  const withoutEntry = { count: money.count(unlinked.count), amount: money.money(unlinked.amount) };
  if (withoutEntry.count !== '0') return degraded('PARCELA_PAGA_SEM_LANCAMENTO', { count: money.count(input.count), withoutEntry }, dimensions);
  return { value: money.money(input.total), status: 'OK', details: { count: money.count(input.count), withoutEntry }, dimensions };
}

const input = (extra = {}) => ({
  asOfDate: '2026-10-28', total: '18000.00', count: 1, byBroker: { 'corretor-1': '18000.00' }, withoutBroker: { count: 0, amount: '0' }, withoutEntry: { count: 0, amount: '0' }, ...extra,
});
const dimsOf = (brokers, month, total, orphan = '0.00', unlinked = { brl: '0.00', qtd: '0' }) => [
  ...Object.entries(brokers).map(([k, v]) => ({ key: `corretor:${k}`, value: v })), { key: `mes:${month}`, value: total },
  { key: 'sem_corretor_brl', value: orphan }, { key: 'sem_lancamento_brl', value: unlinked.brl }, { key: 'sem_lancamento_qtd', value: unlinked.qtd },
];
const okOf = (value, count, dimensions) => ({ value, status: 'OK', details: { count, withoutEntry: { count: '0', amount: '0.00' } }, dimensions });

const testCases = [
  { kind: 'empty', name: 'nenhuma parcela paga no mês: zero com duas casas', input: input({ total: '0', count: 0, byBroker: {} }), expected: okOf('0.00', '0', dimsOf({}, '2026-10', '0.00')) },
  { kind: 'single', name: 'uma parcela paga', input: input({ total: '300.00', byBroker: { c1: '300.00' } }), expected: okOf('300.00', '1', dimsOf({ c1: '300.00' }, '2026-10', '300.00')) },
  { kind: 'typical', name: 'exemplo do livro: outubro tem 18.000,00 pagos', input: input(), expected: okOf('18000.00', '1', dimsOf({ 'corretor-1': '18000.00' }, '2026-10', '18000.00')) },
  {
    kind: 'period_edge', name: 'virada de mês: o mês da data-base é o da dimensão; parcela paga sem lançamento deixa DEGRADED e sem valor', input: input({ asOfDate: '2026-11-01', total: '18300.00', count: 2, withoutEntry: { count: 1, amount: '300.00' } }),
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'PARCELA_PAGA_SEM_LANCAMENTO', count: '2', withoutEntry: { count: '1', amount: '300.00' } },
      dimensions: dimsOf({ 'corretor-1': '18000.00' }, '2026-11', '18300.00', '0.00', { brl: '300.00', qtd: '1' }),
    },
  },
  { kind: 'rounding', name: 'soma com mais de duas casas arredonda uma só vez, meio para cima', input: input({ total: '0.005', byBroker: { c1: '0.005' } }), expected: okOf('0.01', '1', dimsOf({ c1: '0.01' }, '2026-10', '0.01')) },
];

module.exports = { id: 'fin.commissions_paid', version: 1, compute, testCases };
