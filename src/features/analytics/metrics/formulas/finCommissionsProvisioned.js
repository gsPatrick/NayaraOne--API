'use strict';

/**
 * M9-D623 — KPI fin.commissions_provisioned (Comissões provisionadas), versão 1. Posição no fim do dia-base: Σ das parcelas de comissão com direito
 * reconhecido (comissão PENDING ou APPROVED) e ainda não pagas; natureza PLANNED, única e fixa (compromisso existente). Entrada (rm_finance_health):
 * { asOfDate, total, count, byBroker: { corretor: valor }, byComponent: { tipo: valor }, withoutBroker: { count, amount } }. Regra de qualidade:
 * parcela cujo beneficiário não é um corretor (usuário) ativo é contada em "Sem corretor" e, acima de 0, deixa o KPI DEGRADED e sem valor. Dinheiro em
 * decimal exato, arredondado uma só vez (M9-D605).
 */
const money = require('./money');
const { degraded } = require('./_finKpi');

const keys = (map) => Object.keys(map || {}).sort();

function compute(input) {
  const byBroker = input.byBroker || {};
  const byComponent = input.byComponent || {};
  const orphan = input.withoutBroker || { count: 0, amount: '0' };
  const dimensions = [
    ...keys(byBroker).map((k) => ({ key: `corretor:${k}`, value: money.money(byBroker[k]) })),
    ...keys(byComponent).map((k) => ({ key: `tipo:${k}`, value: money.money(byComponent[k]) })),
    { key: 'sem_corretor_brl', value: money.money(orphan.amount) }, { key: 'sem_corretor_qtd', value: money.count(orphan.count) },
  ];
  const withoutBroker = { count: money.count(orphan.count), amount: money.money(orphan.amount) };
  if (withoutBroker.count !== '0') return degraded('PARCELA_SEM_CORRETOR', { count: money.count(input.count), withoutBroker }, dimensions);
  return { value: money.money(input.total), status: 'OK', details: { count: money.count(input.count), withoutBroker }, dimensions };
}

const input = (extra = {}) => ({ asOfDate: '2026-10-28', total: '21000.00', count: 2, byBroker: { 'corretor-1': '21000.00' }, byComponent: { BROKER: '21000.00' }, withoutBroker: { count: 0, amount: '0' }, ...extra });
const none = { sem_corretor_brl: '0.00', sem_corretor_qtd: '0' };
const dimsOf = (brokers, types, orphan = none) => [
  ...Object.entries(brokers).map(([k, v]) => ({ key: `corretor:${k}`, value: v })), ...Object.entries(types).map(([k, v]) => ({ key: `tipo:${k}`, value: v })),
  { key: 'sem_corretor_brl', value: orphan.sem_corretor_brl }, { key: 'sem_corretor_qtd', value: orphan.sem_corretor_qtd },
];
const okOf = (value, count, dimensions) => ({ value, status: 'OK', details: { count, withoutBroker: { count: '0', amount: '0.00' } }, dimensions });

const testCases = [
  { kind: 'empty', name: 'nenhuma parcela provisionada: zero com duas casas', input: input({ total: '0', count: 0, byBroker: {}, byComponent: {} }), expected: okOf('0.00', '0', dimsOf({}, {})) },
  { kind: 'single', name: 'uma parcela de um corretor', input: input({ total: '15000.00', count: 1, byBroker: { c1: '15000.00' }, byComponent: { BROKER: '15000.00' } }), expected: okOf('15000.00', '1', dimsOf({ c1: '15000.00' }, { BROKER: '15000.00' })) },
  {
    kind: 'typical', name: 'exemplo do livro: parcelas devidas 15.000,00 e 6.000,00 dão 21.000,00', input: input({ byBroker: { 'corretor-1': '21000.00' } }),
    expected: okOf('21000.00', '2', dimsOf({ 'corretor-1': '21000.00' }, { BROKER: '21000.00' })),
  },
  {
    kind: 'period_edge', name: 'parcela sem corretor: "Sem corretor" acima de zero deixa DEGRADED, sem valor, e o que tem corretor continua visível', input: input({ total: '22000.00', count: 3, withoutBroker: { count: 1, amount: '1000.00' } }),
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'PARCELA_SEM_CORRETOR', count: '3', withoutBroker: { count: '1', amount: '1000.00' } },
      dimensions: dimsOf({ 'corretor-1': '21000.00' }, { BROKER: '21000.00' }, { sem_corretor_brl: '1000.00', sem_corretor_qtd: '1' }),
    },
  },
  { kind: 'rounding', name: 'soma com mais de duas casas arredonda uma só vez, meio para cima', input: input({ total: '10.005', count: 1, byBroker: { c1: '10.005' }, byComponent: { MANAGER: '10.005' } }), expected: okOf('10.01', '1', dimsOf({ c1: '10.01' }, { MANAGER: '10.01' })) },
];

module.exports = { id: 'fin.commissions_provisioned', version: 1, compute, testCases };
