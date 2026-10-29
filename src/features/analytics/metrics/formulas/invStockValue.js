'use strict';

/**
 * M9-D653 — KPI inv.stock_value (Valor em estoque), versão 1. Σ (quantidade em saldo × custo médio ponderado) dos itens da empresa (tipos do parâmetro
 * analytics.estoque.tipos_item) na data-base, arredondado uma só vez, 2 casas. Posição, natureza ACTUAL. Entrada (rm_inventory_health): { value,
 * itemsWithoutCost }. Regra de qualidade: item com saldo e sem custo médio -> DEGRADED, sem valor (o total ficaria menor que o real). Local e categoria
 * não são dimensões: o read model guarda um total por empresa (DI-D653-2).
 */
const money = require('./money');
const { degraded } = require('./_obraEstoqueKpi');

function compute(input) {
  const withoutCost = money.count(input.itemsWithoutCost || 0);
  const details = { itemsWithoutCost: withoutCost };
  const dimensions = [{ key: 'sem_custo_qtd', value: withoutCost }];
  if (withoutCost !== '0') return degraded('ITEM_COM_SALDO_SEM_CUSTO_MEDIO', details, dimensions);
  return { value: money.money(input.value || 0), status: 'OK', details, dimensions };
}

const okOf = (value) => ({ value, status: 'OK', details: { itemsWithoutCost: '0' }, dimensions: [{ key: 'sem_custo_qtd', value: '0' }] });

const testCases = [
  { kind: 'empty', name: 'estoque sem itens: zero com duas casas', input: { value: '0', itemsWithoutCost: 0 }, expected: okOf('0.00') },
  { kind: 'single', name: 'um item: 10 un a 3,50', input: { value: '35.00', itemsWithoutCost: 0 }, expected: okOf('35.00') },
  { kind: 'typical', name: 'exemplo do livro: 120 un a 3,50 e 40 un a 12,00 = 900,00', input: { value: '900.00', itemsWithoutCost: 0 }, expected: okOf('900.00') },
  {
    kind: 'period_edge', name: 'item com saldo e sem custo médio: DEGRADED e sem valor', input: { value: '900.00', itemsWithoutCost: 1 },
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'ITEM_COM_SALDO_SEM_CUSTO_MEDIO', itemsWithoutCost: '1' }, dimensions: [{ key: 'sem_custo_qtd', value: '1' }] },
  },
  { kind: 'rounding', name: 'valor com mais de duas casas arredonda uma só vez, meio para cima', input: { value: '0.005', itemsWithoutCost: 0 }, expected: okOf('0.01') },
];

module.exports = { id: 'inv.stock_value', version: 1, compute, testCases };
