'use strict';

/**
 * M9-D621 — peça comum dos seis KPIs de janela (contas a pagar e recebíveis em 7, 30 e 60 dias). Cada arquivo de fórmula chama
 * `windowFormula` com o código, a natureza e o tamanho da janela; a regra mora aqui uma vez só. Janela cumulativa em dias de calendário de São
 * Paulo: de hoje (inclusive) até hoje+N-1 (inclusive), limite superior exclusivo à meia-noite seguinte; vencido não entra (é outro KPI).
 * Entrada (linha do rm_finance_health): { asOfDate, amount, withoutDueDate } com o valor já somado no banco (texto decimal) e a contagem de
 * lançamentos pendentes próprios sem vencimento da mesma natureza. Regra de qualidade: lançamento sem vencimento -> INCOMPLETE, valor nulo,
 * contado em details.withoutDueDate (a soma da janela pode estar subestimada). Dinheiro em decimal exato, arredondado uma só vez (M9-D605).
 */
const money = require('./money');
const { addDays } = require('../period.dates');
const { INCOMPLETE_MESSAGE } = require('./_finKpi');

function windowFormula({ id, windowDays, caseAmounts }) {
  function compute(input) {
    const days = String(windowDays);
    const windowEnd = addDays(input.asOfDate, windowDays - 1);
    const withoutDueDate = money.count(input.withoutDueDate || 0);
    const base = { windowDays: days, windowStart: input.asOfDate, windowEnd, withoutDueDate };
    if (withoutDueDate !== '0') return { value: null, status: 'INCOMPLETE', message: INCOMPLETE_MESSAGE, details: { reason: 'LANCAMENTO_SEM_VENCIMENTO', ...base }, dimensions: [] };
    return { value: money.money(input.amount), status: 'OK', details: base, dimensions: [] };
  }
  const input = (extra = {}) => ({ asOfDate: '2026-10-27', amount: '0', withoutDueDate: 0, ...extra });
  const okOf = (value, asOfDate = '2026-10-27') => ({ value, status: 'OK', details: { windowDays: String(windowDays), windowStart: asOfDate, windowEnd: addDays(asOfDate, windowDays - 1), withoutDueDate: '0' }, dimensions: [] });
  const [typical, typicalValue, rounded, roundedValue] = caseAmounts;
  const testCases = [
    { kind: 'empty', name: 'nenhum lançamento na janela: zero com duas casas', input: input(), expected: okOf('0.00') },
    { kind: 'single', name: 'um lançamento', input: input({ amount: '10000.00' }), expected: okOf('10000.00') },
    { kind: 'typical', name: 'exemplo do livro para a janela', input: input({ amount: typical }), expected: okOf(typicalValue) },
    { kind: 'period_edge', name: 'virada de mês e de ano: a janela termina no dia hoje+N-1', input: input({ asOfDate: '2026-12-28', amount: '1.00' }), expected: okOf('1.00', '2026-12-28') },
    { kind: 'rounding', name: 'valor com mais de duas casas arredonda uma vez, meio para cima', input: input({ amount: rounded }), expected: okOf(roundedValue) },
    {
      kind: 'period_edge', name: 'lançamento sem vencimento: INCOMPLETE e sem valor, contado em withoutDueDate', input: input({ amount: '500.00', withoutDueDate: 2 }),
      expected: { value: null, status: 'INCOMPLETE', message: INCOMPLETE_MESSAGE, details: { reason: 'LANCAMENTO_SEM_VENCIMENTO', windowDays: String(windowDays), windowStart: '2026-10-27', windowEnd: addDays('2026-10-27', windowDays - 1), withoutDueDate: '2' }, dimensions: [] },
    },
  ];
  return { id, version: 1, compute, testCases };
}

module.exports = { windowFormula };
