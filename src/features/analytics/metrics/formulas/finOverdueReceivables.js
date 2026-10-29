'use strict';

/**
 * M9-D622 — KPI fin.overdue_receivables (Valor inadimplente), versão 1. Posição no fim do dia-base, em reais com 2 casas, arredondada uma vez: Σ amount das ENTRADAS
 * próprias PENDING com vencimento (calendário de São Paulo) anterior a hoje, sem limite de idade; quem vence hoje NÃO é inadimplente. Dinheiro de terceiros, estornos e
 * cancelados ficam de fora (o read model já aplica o mapa de status do Financeiro).
 * Entrada (rm_finance_health): { asOfDate, total, withoutDueDate, detail } com o detalhe das vencidas (ver _delinquency.js). Parâmetro: bands (analytics.inadimplencia.faixas_atraso_dias).
 * Regra de qualidade: entrada pendente sem data de vencimento -> INCOMPLETE e valor nulo (não se sabe se está vencida), contada em details.withoutDueDate.
 * Dimensões: faixa de atraso, contrato (o que não tem contrato em sem_contrato_brl), quantidade e a parte dentro e fora da janela da taxa.
 */
const money = require('./money');
const { INCOMPLETE_MESSAGE } = require('./_finKpi');
const { bandsOf, contractsOf } = require('./_delinquency');

function compute(input, params = {}) {
  const withoutDueDate = money.count(input.withoutDueDate || 0);
  if (withoutDueDate !== '0') return { value: null, status: 'INCOMPLETE', message: INCOMPLETE_MESSAGE, details: { reason: 'LANCAMENTO_SEM_VENCIMENTO', withoutDueDate }, dimensions: [] };
  const detail = input.detail || {};
  const bands = bandsOf(detail, params.bands);
  const inWindow = money.toString(money.sum(bands.map((b) => b.inWindow)));
  const total = money.money(input.total);
  const outside = money.money(money.sub(input.total, inWindow));
  const without = detail.withoutContract || { amount: '0', inWindow: '0' };
  const dimensions = [
    ...bands.map((b) => ({ key: `faixa:${b.label}`, value: money.money(b.amount) })),
    ...contractsOf(detail).map((c) => ({ key: `contrato:${c.id}`, value: money.money(c.amount) })),
    { key: 'sem_contrato_brl', value: money.money(without.amount) },
    { key: 'quantidade_qtd', value: money.count(detail.count || 0) },
    { key: 'dentro_janela_brl', value: money.money(inWindow) },
    { key: 'fora_janela_brl', value: outside },
  ];
  return { value: total, status: 'OK', details: { count: money.count(detail.count || 0), withoutDueDate, overdueOutsideWindow: outside }, dimensions };
}

const ZERO_DETAIL = { windowDays: 90, total: '0', count: 0, withoutContract: { amount: '0', inWindow: '0' }, byContract: {}, byAge: [] };
const input = (extra = {}) => ({ asOfDate: '2026-10-28', total: '0', withoutDueDate: 0, detail: ZERO_DETAIL, ...extra });
const age = (date, lateDays, amount, count = 1) => ({ date, lateDays, amount, count });
const dims = (faixas, contratos, semContrato, qtd, dentro, fora) => [
  ...['1-30', '31-60', '61-90', '90+'].map((l, i) => ({ key: `faixa:${l}`, value: faixas[i] })), ...contratos.map(([id, v]) => ({ key: `contrato:${id}`, value: v })),
  { key: 'sem_contrato_brl', value: semContrato }, { key: 'quantidade_qtd', value: qtd }, { key: 'dentro_janela_brl', value: dentro }, { key: 'fora_janela_brl', value: fora },
];
const okOf = (value, count, outside, dimensions) => ({ value, status: 'OK', details: { count, withoutDueDate: '0', overdueOutsideWindow: outside }, dimensions });
const bad = { value: null, status: 'INCOMPLETE', message: INCOMPLETE_MESSAGE, details: { reason: 'LANCAMENTO_SEM_VENCIMENTO', withoutDueDate: '2' }, dimensions: [] };

const testCases = [
  { kind: 'empty', name: 'nenhuma entrada vencida: zero com duas casas', input: input(), expected: okOf('0.00', '0', '0.00', dims(['0.00', '0.00', '0.00', '0.00'], [], '0.00', '0', '0.00', '0.00')) },
  {
    kind: 'single', name: 'um vencido de 100,00 há 5 dias', input: input({ total: '100.00', detail: { ...ZERO_DETAIL, total: '100.00', count: 1, byContract: { c1: { amount: '100.00', inWindow: '100.00' } }, byAge: [age('2026-10-23', 5, '100.00')] } }),
    expected: okOf('100.00', '1', '0.00', dims(['100.00', '0.00', '0.00', '0.00'], [['c1', '100.00']], '0.00', '1', '100.00', '0.00')),
  },
  {
    kind: 'typical', name: 'exemplo do livro: 12.000,00 (15 dias) + 4.000,00 (70 dias) = 16.000,00; 9.000,00 há 120 dias fica fora da janela e dentro do total',
    input: input({
      total: '25000.00',
      detail: { ...ZERO_DETAIL, total: '25000.00', count: 3, byContract: { c1: { amount: '21000.00', inWindow: '12000.00' }, c2: { amount: '4000.00', inWindow: '4000.00' } }, byAge: [age('2026-06-30', 120, '9000.00'), age('2026-08-19', 70, '4000.00'), age('2026-10-13', 15, '12000.00')] },
    }),
    expected: okOf('25000.00', '3', '9000.00', dims(['12000.00', '0.00', '4000.00', '9000.00'], [['c1', '21000.00'], ['c2', '4000.00']], '0.00', '3', '16000.00', '9000.00')),
  },
  {
    kind: 'period_edge', name: 'fronteiras das faixas (30, 31, 60, 61, 90, 91 dias) e janela de 90 dias (atraso 89 dentro, 90 fora); sem contrato à parte',
    input: input({
      total: '60.00',
      detail: {
        ...ZERO_DETAIL, total: '60.00', count: 6, withoutContract: { amount: '60.00', inWindow: '30.00' },
        byAge: [age('x', 30, '10.00'), age('x', 31, '10.00'), age('x', 60, '10.00'), age('x', 61, '10.00'), age('x', 89, '10.00'), age('x', 90, '10.00')],
      },
    }),
    params: { bands: [30, 60, 90] }, expected: okOf('60.00', '6', '10.00', dims(['10.00', '20.00', '30.00', '0.00'], [], '60.00', '6', '50.00', '10.00')),
  },
  {
    kind: 'rounding', name: 'valor com mais de duas casas arredonda uma só vez, meio para cima',
    input: input({ total: '0.005', detail: { ...ZERO_DETAIL, total: '0.005', count: 1, byAge: [age('2026-10-27', 1, '0.005')] } }),
    expected: okOf('0.01', '1', '0.00', dims(['0.01', '0.00', '0.00', '0.00'], [], '0.00', '1', '0.01', '0.00')),
  },
  { kind: 'period_edge', name: 'entrada pendente sem vencimento: INCOMPLETE e sem valor', input: input({ total: '500.00', withoutDueDate: 2 }), expected: bad },
  {
    kind: 'period_edge', name: 'faixas do administrador (15 e 45) mudam o corte', params: { bands: [15, 45] },
    input: input({ total: '30.00', detail: { ...ZERO_DETAIL, total: '30.00', count: 3, byAge: [age('x', 15, '10.00'), age('x', 16, '10.00'), age('x', 46, '10.00')] } }),
    expected: okOf('30.00', '3', '0.00', [
      { key: 'faixa:1-15', value: '10.00' }, { key: 'faixa:16-45', value: '10.00' }, { key: 'faixa:45+', value: '10.00' },
      { key: 'sem_contrato_brl', value: '0.00' }, { key: 'quantidade_qtd', value: '3' }, { key: 'dentro_janela_brl', value: '30.00' }, { key: 'fora_janela_brl', value: '0.00' },
    ]),
  },
];

module.exports = { id: 'fin.overdue_receivables', version: 1, compute, testCases };
