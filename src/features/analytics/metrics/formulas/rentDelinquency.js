'use strict';

/**
 * M9-D640 — KPI rent.delinquency (Inadimplência da locação), versão 1. Posição no fim do dia-base, em percentual com 2 casas, arredondado uma vez: o recorte de locação de
 * fin.delinquency_rate (M9-D622): taxa = vencidoNaJanela ÷ cobrado × 100, só com entradas próprias de contratos de locação; vencidoNaJanela = Σ amount das entradas PENDING com
 * vencimento (calendário de São Paulo) em [hoje − janela + 1, hoje − 1] e cobrado = Σ das entradas (exceto REVERSED e CANCELLED) com vencimento na mesma janela mais hoje. O vencido
 * antes da janela fica fora da taxa e em details.overdueOutsideWindow. O valor vencido absoluto (sem limite de idade) sai em vencido_brl. Entrada (rm_rental_arrears, linha da data-base):
 * { row: { billed, overdueAmount, inWindow, outside, withoutDueDate, unlinkedAmount, unlinkedCount, byAge, byContract, byProperty } | null, windowDays }. Parâmetro: bands (faixas de atraso).
 * Modo de reconciliação (M9-D611): as linhas-fonte [{ status, amount, due_day }] com params.asOfDate. Regra de qualidade: cobrança sem contrato de locação NÃO rebaixa o KPI: fica só no
 * Financeiro e entra em details.unlinked (DI-D640-3); entrada de locação pendente sem vencimento ou cobrado zero -> INCOMPLETE; retrato não calculado -> DEGRADED. Valor nulo nesses casos.
 */
const money = require('./money');
const { degraded, incomplete } = require('./_legalCorKpi');
const { bandsOf, contractsOf, rateFromRows } = require('./_delinquency');

const share = (part, base) => money.percent(part, base).value;
const FIELDS = ['billed', 'overdueAmount', 'inWindow', 'outside', 'withoutDueDate', 'unlinkedAmount', 'unlinkedCount'];

function keyed(prefix, map, base) {
  return Object.keys(map || {}).sort().filter((id) => !money.isZero(map[id].inWindow)).map((id) => ({ key: `${prefix}:${id}`, value: share(map[id].inWindow, base) }));
}

function compute(input, params = {}) {
  if (Array.isArray(input)) return rateFromRows(input, params.asOfDate);
  const row = input.row;
  if (!row || FIELDS.some((f) => row[f] === null || row[f] === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', {});
  const unlinked = { amount: money.money(row.unlinkedAmount), count: money.count(row.unlinkedCount) };
  const details = { overdueOutsideWindow: money.money(row.outside), unlinked, withoutDueDate: money.count(row.withoutDueDate) };
  if (details.withoutDueDate !== '0') return incomplete('LANCAMENTO_SEM_VENCIMENTO', details);
  const rate = money.percent(row.inWindow, row.billed);
  if (rate.status !== 'OK') return incomplete('BASE_ZERO', details);
  const detail = { windowDays: input.windowDays, byAge: row.byAge || [], byContract: row.byContract || {} };
  const dimensions = [
    ...bandsOf(detail, params.bands).map((b) => ({ key: `faixa:${b.label}`, value: share(b.inWindow, row.billed) })),
    ...keyed('contrato', row.byContract, row.billed), ...keyed('imovel', row.byProperty, row.billed),
    { key: 'vencido_brl', value: money.money(row.overdueAmount) }, { key: 'vencido_janela_brl', value: money.money(row.inWindow) }, { key: 'cobrado_brl', value: money.money(row.billed) },
    { key: 'fora_janela_brl', value: details.overdueOutsideWindow }, { key: 'nao_vinculado_brl', value: unlinked.amount }, { key: 'nao_vinculado_qtd', value: unlinked.count },
  ];
  return { value: rate.value, status: 'OK', details: { ...details, overdueAmount: money.money(row.overdueAmount), billed: money.money(row.billed), contracts: contractsOf(detail).length }, dimensions };
}

const mk = (extra = {}) => ({ row: { billed: '0', overdueAmount: '0', inWindow: '0', outside: '0', withoutDueDate: 0, unlinkedAmount: '0', unlinkedCount: 0, byAge: [], byContract: {}, byProperty: {}, ...extra }, windowDays: 90 });
const age = (lateDays, amount) => ({ date: 'x', lateDays, amount, count: 1 });
const bands = (a, b, c, d) => [{ key: 'faixa:1-30', value: a }, { key: 'faixa:31-60', value: b }, { key: 'faixa:61-90', value: c }, { key: 'faixa:90+', value: d }];
const tail = (overdue, inWin, billed, outside, unl = '0.00', unlQtd = '0') => [
  { key: 'vencido_brl', value: overdue }, { key: 'vencido_janela_brl', value: inWin }, { key: 'cobrado_brl', value: billed }, { key: 'fora_janela_brl', value: outside }, { key: 'nao_vinculado_brl', value: unl }, { key: 'nao_vinculado_qtd', value: unlQtd },
];
const okOf = (value, overdue, billed, outside, contracts, dimensions, unl = '0.00', unlQtd = '0') => ({
  value, status: 'OK', details: { overdueOutsideWindow: outside, unlinked: { amount: unl, count: unlQtd }, withoutDueDate: '0', overdueAmount: overdue, billed, contracts }, dimensions,
});
const lost = 'Dado incompleto, valor não confiável.';
const noValue = (status, reason, details) => ({ value: null, status, message: lost, details: { reason, ...details }, dimensions: [] });
const baseDetails = (extra = {}) => ({ overdueOutsideWindow: '0.00', unlinked: { amount: '0.00', count: '0' }, withoutDueDate: '0', ...extra });

const testCases = [
  { kind: 'empty', name: 'nada cobrado na janela: INCOMPLETE e sem valor (nunca 0%)', input: mk(), expected: noValue('INCOMPLETE', 'BASE_ZERO', baseDetails()) },
  {
    kind: 'single', name: 'um vencido de 10,00 numa cobrança de 100,00 => 10,00%',
    input: mk({ billed: '100.00', overdueAmount: '10.00', inWindow: '10.00', byAge: [age(5, '10.00')], byContract: { c1: { amount: '10.00', inWindow: '10.00' } }, byProperty: { p1: { amount: '10.00', inWindow: '10.00' } } }),
    expected: okOf('10.00', '10.00', '100.00', '0.00', 1, [...bands('10.00', '0.00', '0.00', '0.00'), { key: 'contrato:c1', value: '10.00' }, { key: 'imovel:p1', value: '10.00' }, ...tail('10.00', '10.00', '100.00', '0.00')]),
  },
  {
    kind: 'typical', name: 'exemplo do livro: vencido 8.200,00; cobrado 200.000,00 => 4,10%; 3.000,00 de outra cobrança sem contrato de locação ficam só no Financeiro (details.unlinked)',
    input: mk({ billed: '200000.00', overdueAmount: '8200.00', inWindow: '8200.00', unlinkedAmount: '3000.00', unlinkedCount: 2, byAge: [age(10, '5200.00'), age(40, '3000.00')], byContract: { c1: { amount: '8200.00', inWindow: '8200.00' } } }),
    expected: okOf('4.10', '8200.00', '200000.00', '0.00', 1, [...bands('2.60', '1.50', '0.00', '0.00'), { key: 'contrato:c1', value: '4.10' }, ...tail('8200.00', '8200.00', '200000.00', '0.00', '3000.00', '2')], '3000.00', '2'),
  },
  {
    kind: 'period_edge', name: 'vencido há 120 dias fica fora da taxa e dentro do valor absoluto; o atraso de 89 dias está dentro e o de 90 fora da janela de 90 dias',
    input: mk({ billed: '1000.00', overdueAmount: '300.00', inWindow: '100.00', outside: '200.00', byAge: [age(89, '100.00'), age(90, '100.00'), age(120, '100.00')] }),
    expected: okOf('10.00', '300.00', '1000.00', '200.00', 0, [...bands('0.00', '0.00', '10.00', '0.00'), ...tail('300.00', '100.00', '1000.00', '200.00')]),
  },
  {
    kind: 'rounding', name: '2 ÷ 3 => 66,67% (meio para cima, uma vez)', input: mk({ billed: '3.00', overdueAmount: '2.00', inWindow: '2.00' }),
    expected: okOf('66.67', '2.00', '3.00', '0.00', 0, [...bands('0.00', '0.00', '0.00', '0.00'), ...tail('2.00', '2.00', '3.00', '0.00')]),
  },
  { kind: 'period_edge', name: 'entrada de locação pendente sem vencimento: INCOMPLETE e sem valor', input: mk({ billed: '100.00', inWindow: '10.00', withoutDueDate: 1 }), expected: noValue('INCOMPLETE', 'LANCAMENTO_SEM_VENCIMENTO', baseDetails({ withoutDueDate: '1' })) },
  { kind: 'period_edge', name: 'retrato do dia ainda não calculado: DEGRADED e sem valor', input: { row: null, windowDays: 90 }, expected: noValue('DEGRADED', 'READ_MODEL_NAO_RECALCULADO', {}) },
  {
    kind: 'period_edge', name: 'reconciliação sobre as linhas-fonte: 8,00% (só PENDING vencido antes de hoje conta)', params: { asOfDate: '2026-10-28' },
    input: [{ status: 'PENDING', amount: '16000.00', due_day: '2026-10-13' }, { status: 'PENDING', amount: '1500.00', due_day: '2026-10-28' }, { status: 'SETTLED', amount: '182500.00', due_day: '2026-09-28' }],
    expected: { value: '8.00', status: 'OK', details: {}, dimensions: [] },
  },
];

module.exports = { id: 'rent.delinquency', version: 1, compute, testCases };
