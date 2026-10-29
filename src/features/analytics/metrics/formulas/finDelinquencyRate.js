'use strict';

/**
 * M9-D622 — KPI fin.delinquency_rate (Taxa de inadimplência), versão 1. Posição no fim do dia-base, em percentual com 2 casas, arredondado uma vez:
 *   taxa = vencidoNaJanela ÷ base × 100
 *   vencidoNaJanela = Σ amount das ENTRADAS próprias PENDING com vencimento (calendário de São Paulo) em [hoje − janela + 1, hoje − 1] (janela = analytics.inadimplencia.janela_dias, padrão 90)
 *   base            = Σ amount das ENTRADAS próprias (qualquer status exceto REVERSED e CANCELLED) com vencimento na MESMA janela mais hoje
 * Dívida vencida antes da janela não entra na taxa (nem no numerador nem na base), de modo que a taxa nunca passa de 100%; ela continua em fin.overdue_receivables e em
 * details.overdueOutsideWindow. Entrada (rm_finance_health): { asOfDate, overdueInWindow, overdueOutsideWindow, base, withoutDueDate, detail }. Modo de reconciliação (M9-D611):
 * [{ status, amount, due_day }] (as linhas-fonte) com params.asOfDate refaz a taxa sobre as linhas-fonte. Parâmetro: bands (faixas de atraso).
 * Regra de qualidade: base zero -> INCOMPLETE, valor nulo; entrada pendente sem vencimento -> INCOMPLETE (não se sabe se está na janela). Nunca um número enganoso.
 */
const money = require('./money');
const { INCOMPLETE_MESSAGE } = require('./_finKpi');
const { bandsOf, contractsOf, rateFromRows } = require('./_delinquency');

const incomplete = (reason, details) => ({ value: null, status: 'INCOMPLETE', message: INCOMPLETE_MESSAGE, details: { reason, ...details }, dimensions: [] });
const share = (part, base) => money.percent(part, base).value;

function compute(input, params = {}) {
  if (Array.isArray(input)) return rateFromRows(input, params.asOfDate); // reconciliação (M9-D611): as linhas-fonte do filtro
  const withoutDueDate = money.count(input.withoutDueDate || 0);
  const outside = money.money(input.overdueOutsideWindow || 0);
  const details = { overdueOutsideWindow: outside, withoutDueDate };
  if (withoutDueDate !== '0') return incomplete('LANCAMENTO_SEM_VENCIMENTO', details);
  const rate = money.percent(input.overdueInWindow, input.base);
  if (rate.status !== 'OK') return incomplete('BASE_ZERO', details);
  const detail = input.detail || {};
  const without = detail.withoutContract || { inWindow: '0' };
  const dimensions = [
    ...bandsOf(detail, params.bands).map((b) => ({ key: `faixa:${b.label}`, value: share(b.inWindow, input.base) })),
    ...contractsOf(detail).filter((c) => !money.isZero(c.inWindow)).map((c) => ({ key: `contrato:${c.id}`, value: share(c.inWindow, input.base) })),
    { key: 'sem_contrato_pct', value: share(without.inWindow, input.base) },
    { key: 'vencido_janela_brl', value: money.money(input.overdueInWindow) },
    { key: 'base_brl', value: money.money(input.base) },
    { key: 'fora_janela_brl', value: outside },
  ];
  return { value: rate.value, status: 'OK', details: { ...details, overdueInWindow: money.money(input.overdueInWindow), base: money.money(input.base) }, dimensions };
}

const ZERO_DETAIL = { windowDays: 90, total: '0', count: 0, withoutContract: { amount: '0', inWindow: '0' }, byContract: {}, byAge: [] };
const input = (extra = {}) => ({ asOfDate: '2026-10-28', overdueInWindow: '0', overdueOutsideWindow: '0', base: '0', withoutDueDate: 0, detail: ZERO_DETAIL, ...extra });
const age = (lateDays, amount) => ({ date: 'x', lateDays, amount, count: 1 });
const bandDims = (a, b, c, d) => [{ key: 'faixa:1-30', value: a }, { key: 'faixa:31-60', value: b }, { key: 'faixa:61-90', value: c }, { key: 'faixa:90+', value: d }];
const tail = (semContrato, venc, base, fora) => [{ key: 'sem_contrato_pct', value: semContrato }, { key: 'vencido_janela_brl', value: venc }, { key: 'base_brl', value: base }, { key: 'fora_janela_brl', value: fora }];
const okOf = (value, venc, base, fora, dimensions) => ({ value, status: 'OK', details: { overdueOutsideWindow: fora, withoutDueDate: '0', overdueInWindow: venc, base }, dimensions });
const bad = (reason, fora, without) => ({ value: null, status: 'INCOMPLETE', message: INCOMPLETE_MESSAGE, details: { reason, overdueOutsideWindow: fora, withoutDueDate: without }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'base zero: INCOMPLETE e sem valor (nunca 0%)', input: input(), expected: bad('BASE_ZERO', '0.00', '0') },
  {
    kind: 'single', name: 'um vencido de 10,00 numa base de 100,00 => 10,00%', input: input({ overdueInWindow: '10.00', base: '100.00', detail: { ...ZERO_DETAIL, byContract: { c1: { amount: '10.00', inWindow: '10.00' } }, byAge: [age(5, '10.00')] } }),
    expected: okOf('10.00', '10.00', '100.00', '0.00', [...bandDims('10.00', '0.00', '0.00', '0.00'), { key: 'contrato:c1', value: '10.00' }, ...tail('0.00', '10.00', '100.00', '0.00')]),
  },
  {
    kind: 'typical', name: 'exemplo do livro: vencido na janela 16.000,00; base 200.000,00 => 8,00%; mais 9.000,00 há 120 dias: a taxa continua 8,00% e 9.000,00 vai para fora da janela',
    input: input({
      overdueInWindow: '16000.00', overdueOutsideWindow: '9000.00', base: '200000.00',
      detail: { ...ZERO_DETAIL, byContract: { c1: { amount: '21000.00', inWindow: '12000.00' }, c2: { amount: '4000.00', inWindow: '4000.00' } }, byAge: [age(120, '9000.00'), age(70, '4000.00'), age(15, '12000.00')] },
    }),
    expected: okOf('8.00', '16000.00', '200000.00', '9000.00', [...bandDims('6.00', '0.00', '2.00', '0.00'), { key: 'contrato:c1', value: '6.00' }, { key: 'contrato:c2', value: '2.00' }, ...tail('0.00', '16000.00', '200000.00', '9000.00')]),
  },
  {
    kind: 'period_edge', name: 'tudo vencido e tudo na janela: 100,00% (teto); sem contrato à parte', input: input({ overdueInWindow: '50.00', base: '50.00', detail: { ...ZERO_DETAIL, withoutContract: { amount: '50.00', inWindow: '50.00' }, byAge: [age(89, '50.00')] } }),
    expected: okOf('100.00', '50.00', '50.00', '0.00', [...bandDims('0.00', '0.00', '100.00', '0.00'), ...tail('100.00', '50.00', '50.00', '0.00')]),
  },
  {
    kind: 'rounding', name: '2 ÷ 3 => 66,67% (meio para cima, uma vez)', input: input({ overdueInWindow: '2.00', base: '3.00' }),
    expected: okOf('66.67', '2.00', '3.00', '0.00', [...bandDims('0.00', '0.00', '0.00', '0.00'), ...tail('0.00', '2.00', '3.00', '0.00')]),
  },
  { kind: 'period_edge', name: 'entrada pendente sem vencimento: INCOMPLETE e sem valor', input: input({ overdueInWindow: '10.00', base: '100.00', withoutDueDate: 3 }), expected: bad('LANCAMENTO_SEM_VENCIMENTO', '0.00', '3') },
  {
    kind: 'period_edge', name: 'reconciliação sobre as linhas-fonte: só PENDING com vencimento anterior a hoje é vencido; hoje não é',
    params: { asOfDate: '2026-10-28' }, input: [{ status: 'PENDING', amount: '12000.00', due_day: '2026-10-13' }, { status: 'PENDING', amount: '4000.00', due_day: '2026-08-19' }, { status: 'PENDING', amount: '1500.00', due_day: '2026-10-28' }, { status: 'SETTLED', amount: '182500.00', due_day: '2026-09-28' }],
    expected: { value: '8.00', status: 'OK', details: {}, dimensions: [] },
  },
];

module.exports = { id: 'fin.delinquency_rate', version: 1, compute, testCases };
