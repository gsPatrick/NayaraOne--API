'use strict';

/**
 * M9-D632 — KPI prop.price_changes (Preço e mudanças de preço), versão 1. Valor = mudanças de preço de oferta no período (data da mudança em São
 * Paulo). A variação média percentual = média de (novo - anterior) ÷ anterior × 100 (2 casas, uma vez; redução é negativa) vai em dimensão, com as
 * mudanças por corretor. Entrada (soma dos dias no rm_property_price_changes): { changes, withPrior, pctSum, byBroker: { corretor: n } }. Histórico
 * sem preço anterior (primeira entrada) não entra na variação (details.withoutPrior); se há mudanças e NENHUMA tem preço anterior, a variação não
 * existe e o KPI sai INCOMPLETE com valor nulo.
 */
const money = require('./money');
const { incomplete, count, brokerDimensions } = require('./_bizKpi');

function compute(input) {
  const changes = count(input.changes);
  const withPrior = count(input.withPrior);
  const withoutPrior = money.count(money.sub(changes, withPrior));
  const details = { changes, withPrior, withoutPrior };
  if (changes !== '0' && withPrior === '0') return incomplete('SEM_PRECO_ANTERIOR', details);
  const dimensions = [];
  let average = null;
  if (withPrior !== '0') {
    average = money.round(money.div(input.pctSum || 0, withPrior), 2);
    dimensions.push({ key: 'variacao_media_pct', value: average });
  }
  dimensions.push(...brokerDimensions(input.byBroker, 'mudancas'));
  return { value: changes, status: 'OK', details: { ...details, averageChangePct: average }, dimensions };
}

const input = (extra = {}) => ({ changes: 8, withPrior: 8, pctSum: '-25.6000', byBroker: { b1: 5, b2: 3 }, ...extra });
const okOf = (changes, withPrior, withoutPrior, average, brokers = []) => ({
  value: changes, status: 'OK', details: { changes, withPrior, withoutPrior, averageChangePct: average },
  dimensions: [...(average === null ? [] : [{ key: 'variacao_media_pct', value: average }]), ...brokers],
});

const testCases = [
  { kind: 'empty', name: 'nenhuma mudança de preço: zero e sem média', input: input({ changes: 0, withPrior: 0, pctSum: 0, byBroker: {} }), expected: okOf('0', '0', '0', null) },
  { kind: 'single', name: 'uma mudança de +10%', input: input({ changes: 1, withPrior: 1, pctSum: '10.0000', byBroker: { b1: 1 } }), expected: okOf('1', '1', '0', '10.00', [{ key: 'corretor:b1:mudancas', value: '1' }]) },
  {
    kind: 'typical', name: 'exemplo do livro: 8 mudanças, média -3,20%', input: input(),
    expected: okOf('8', '8', '0', '-3.20', [{ key: 'corretor:b1:mudancas', value: '5' }, { key: 'corretor:b2:mudancas', value: '3' }]),
  },
  { kind: 'period_edge', name: 'primeira entrada do histórico fica fora da variação e é contada à parte', input: input({ changes: 4, withPrior: 3, pctSum: '-9.0000', byBroker: {} }), expected: okOf('4', '3', '1', '-3.00') },
  { kind: 'rounding', name: 'média arredonda uma vez, meio para cima, afastando do zero: -0,005 vira -0,01', input: input({ changes: 2, withPrior: 2, pctSum: '-0.0100', byBroker: {} }), expected: okOf('2', '2', '0', '-0.01') },
  {
    kind: 'period_edge', name: 'só primeiras entradas: variação inexistente, INCOMPLETE e sem valor', input: input({ changes: 3, withPrior: 0, pctSum: 0 }),
    expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'SEM_PRECO_ANTERIOR', changes: '3', withPrior: '0', withoutPrior: '3' }, dimensions: [] },
  },
];

module.exports = { id: 'prop.price_changes', version: 1, compute, testCases };
