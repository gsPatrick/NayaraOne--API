'use strict';

/**
 * M9-D620 — KPI fin.third_party_cash (Dinheiro de terceiros), versão 1. Posição no fim do dia-base, em reais com 2 casas, arredondada uma vez:
 *   terceiros = entradas liquidadas de terceiros - devoluções liquidadas - compensações liquidadas   (por empresa; detalhe por origem)
 * Entrada (linha do rm_finance_health): { asOfDate, inflow, returned, compensated, byOrigin: { CAUCAO, REPASSE, OUTRO } }.
 * Regra de qualidade: saldo de terceiros negativo (devolveu ou compensou mais do que recebeu) deixa o KPI DEGRADED com valor nulo e o motivo
 * "liberação sem entrada correspondente".
 */
const money = require('./money');
const { degraded } = require('./_finKpi');

const ORIGINS = ['CAUCAO', 'REPASSE', 'OUTRO'];
const ZERO = '0.00';
const sumOf = (list) => money.money(money.toString(money.sum(list)));
const minus = (a, b) => money.money(money.toString(money.sub(a, b)));

function compute(input) {
  const inflow = sumOf([input.inflow || ZERO]);
  const returned = sumOf([input.returned || ZERO]);
  const compensated = sumOf([input.compensated || ZERO]);
  const value = minus(minus(inflow, returned), compensated);
  const byOrigin = Object.fromEntries(ORIGINS.map((o) => [o, sumOf([(input.byOrigin || {})[o] || ZERO])]));
  const dimensions = ORIGINS.map((o) => ({ key: `origem:${o}`, value: byOrigin[o] }));
  const details = { inflow, released: sumOf([returned, compensated]), returned, compensated, byOrigin };
  if (money.cmp(value, ZERO) < 0) {
    return degraded('LIBERACAO_SEM_ENTRADA_CORRESPONDENTE', { ...details, reasonText: 'liberação sem entrada correspondente' }, dimensions);
  }
  return { value, status: 'OK', details, dimensions };
}

const input = (extra = {}) => ({ asOfDate: '2026-10-28', inflow: '35000.00', returned: '0.00', compensated: '0.00', byOrigin: { CAUCAO: '8000.00', REPASSE: '27000.00', OUTRO: '0.00' }, ...extra });
const origins = (c, r, o) => ({ CAUCAO: c, REPASSE: r, OUTRO: o });
const dims = (c, r, o) => [{ key: 'origem:CAUCAO', value: c }, { key: 'origem:REPASSE', value: r }, { key: 'origem:OUTRO', value: o }];

const testCases = [
  {
    kind: 'empty', name: 'nenhum dinheiro de terceiros', input: input({ inflow: '0.00', byOrigin: origins('0.00', '0.00', '0.00') }),
    expected: { value: '0.00', status: 'OK', details: { inflow: '0.00', released: '0.00', returned: '0.00', compensated: '0.00', byOrigin: origins('0.00', '0.00', '0.00') }, dimensions: dims('0.00', '0.00', '0.00') },
  },
  {
    kind: 'single', name: 'uma caução de 5.000,00 recebida', input: input({ inflow: '5000.00', byOrigin: origins('5000.00', '0.00', '0.00') }),
    expected: { value: '5000.00', status: 'OK', details: { inflow: '5000.00', released: '0.00', returned: '0.00', compensated: '0.00', byOrigin: origins('5000.00', '0.00', '0.00') }, dimensions: dims('5000.00', '0.00', '0.00') },
  },
  {
    kind: 'typical', name: 'exemplo da demanda: caução 8.000, repasse retido 27.000, liberação 0 => 35.000', input: input(),
    expected: { value: '35000.00', status: 'OK', details: { inflow: '35000.00', released: '0.00', returned: '0.00', compensated: '0.00', byOrigin: origins('8000.00', '27000.00', '0.00') }, dimensions: dims('8000.00', '27000.00', '0.00') },
  },
  {
    kind: 'period_edge', name: 'devolução e compensação abatem do saldo; liberar tudo deixa zero (não é negativo)', input: input({ inflow: '8000.00', returned: '5000.00', compensated: '3000.00', byOrigin: origins('0.00', '0.00', '0.00') }),
    expected: { value: '0.00', status: 'OK', details: { inflow: '8000.00', released: '8000.00', returned: '5000.00', compensated: '3000.00', byOrigin: origins('0.00', '0.00', '0.00') }, dimensions: dims('0.00', '0.00', '0.00') },
  },
  {
    kind: 'period_edge', name: 'liberação maior que a entrada: DEGRADED, sem valor, com o motivo', input: input({ inflow: '1000.00', returned: '1000.01', byOrigin: origins('-0.01', '0.00', '0.00') }),
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', dimensions: dims('-0.01', '0.00', '0.00'),
      details: { reason: 'LIBERACAO_SEM_ENTRADA_CORRESPONDENTE', inflow: '1000.00', released: '1000.01', returned: '1000.01', compensated: '0.00', byOrigin: origins('-0.01', '0.00', '0.00'), reasonText: 'liberação sem entrada correspondente' },
    },
  },
  {
    kind: 'rounding', name: 'centavos exatos e arredondamento uma vez só', input: input({ inflow: '0.10', returned: '0.0349', byOrigin: origins('0.00', '0.00', '0.065') }),
    expected: { value: '0.07', status: 'OK', details: { inflow: '0.10', released: '0.03', returned: '0.03', compensated: '0.00', byOrigin: origins('0.00', '0.00', '0.07') }, dimensions: dims('0.00', '0.00', '0.07') },
  },
];

module.exports = { id: 'fin.third_party_cash', version: 1, compute, testCases };
