'use strict';

/**
 * M9-D653 — KPI inv.below_minimum (Itens abaixo do mínimo e rupturas), versão 1. Contagem dos itens com saldo total menor que o estoque mínimo; as
 * rupturas (item com mínimo definido e saldo zero ou menor) são um subconjunto, em dimensão própria. Item ativo sem mínimo fica fora da contagem e vai
 * para details.noMinimum. Posição, natureza ACTUAL. Entrada (rm_inventory_health): { belowMin, ruptures, withoutMin }. Regra de qualidade: qualquer item
 * ativo sem estoque mínimo -> DEGRADED, sem valor (completude, M9-D696). Por categoria: o read model guarda um total por empresa (DI-D653-2).
 */
const money = require('./money');
const { degraded } = require('./_obraEstoqueKpi');

function compute(input) {
  const withoutMin = money.count(input.withoutMin || 0);
  const details = { ruptures: money.count(input.ruptures || 0), noMinimum: withoutMin };
  const dimensions = [{ key: 'rupturas_qtd', value: details.ruptures }, { key: 'sem_minimo_qtd', value: withoutMin }];
  if (withoutMin !== '0') return degraded('ITEM_ATIVO_SEM_ESTOQUE_MINIMO', details, dimensions);
  return { value: money.count(input.belowMin || 0), status: 'OK', details, dimensions };
}

const okOf = (value, ruptures) => ({ value, status: 'OK', details: { ruptures, noMinimum: '0' }, dimensions: [{ key: 'rupturas_qtd', value: ruptures }, { key: 'sem_minimo_qtd', value: '0' }] });

const testCases = [
  { kind: 'empty', name: 'nenhum item abaixo do mínimo', input: { belowMin: 0, ruptures: 0, withoutMin: 0 }, expected: okOf('0', '0') },
  { kind: 'single', name: 'um item em ruptura também está abaixo do mínimo', input: { belowMin: 1, ruptures: 1, withoutMin: 0 }, expected: okOf('1', '1') },
  { kind: 'typical', name: 'exemplo do livro: 9 abaixo do mínimo, 2 em ruptura', input: { belowMin: 9, ruptures: 2, withoutMin: 0 }, expected: okOf('9', '2') },
  {
    kind: 'period_edge', name: 'item ativo sem estoque mínimo: DEGRADED e sem valor, contado em noMinimum', input: { belowMin: 9, ruptures: 2, withoutMin: 3 },
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'ITEM_ATIVO_SEM_ESTOQUE_MINIMO', ruptures: '2', noMinimum: '3' }, dimensions: [{ key: 'rupturas_qtd', value: '2' }, { key: 'sem_minimo_qtd', value: '3' }] },
  },
  { kind: 'rounding', name: 'contagem vinda do banco como texto continua inteira', input: { belowMin: '12', ruptures: '4', withoutMin: '0' }, expected: okOf('12', '4') },
];

module.exports = { id: 'inv.below_minimum', version: 1, compute, testCases };
