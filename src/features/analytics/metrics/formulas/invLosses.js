'use strict';

/**
 * M9-D653 — KPI inv.losses (Perdas de estoque no período), versão 1. Σ do valor das perdas decididas como perda (casos APPROVED) nos dias da janela do
 * parâmetro analytics.estoque.janela_perdas_dias (padrão 30) até a data-base (calendário de São Paulo), pelo custo do movimento de baixa ou, se a baixa não tem custo, o estimado do caso; arredondado uma só vez,
 * 2 casas. A quantidade de perdas e os casos ainda abertos (sem decisão) ficam em separado. Posição, natureza ACTUAL. Entrada (rm_inventory_health):
 * { value, count, open, withoutValue }. Regra de qualidade: perda decidida sem valor nenhum -> DEGRADED, sem valor. Por tipo de perda e por obra: o read
 * model guarda um total por empresa (DI-D653-2).
 */
const money = require('./money');
const { degraded } = require('./_obraEstoqueKpi');

function compute(input) {
  const withoutValue = money.count(input.withoutValue || 0);
  const details = { count: money.count(input.count || 0), open: money.count(input.open || 0), withoutValue };
  const dimensions = [{ key: 'casos_qtd', value: details.count }, { key: 'abertos_qtd', value: details.open }, { key: 'sem_valor_qtd', value: withoutValue }];
  if (withoutValue !== '0') return degraded('PERDA_DECIDIDA_SEM_VALOR', details, dimensions);
  return { value: money.money(input.value || 0), status: 'OK', details, dimensions };
}

const okOf = (value, count, open) => ({ value, status: 'OK', details: { count, open, withoutValue: '0' }, dimensions: [{ key: 'casos_qtd', value: count }, { key: 'abertos_qtd', value: open }, { key: 'sem_valor_qtd', value: '0' }] });

const testCases = [
  { kind: 'empty', name: 'nenhuma perda no período: zero com duas casas', input: { value: '0', count: 0, open: 0, withoutValue: 0 }, expected: okOf('0.00', '0', '0') },
  { kind: 'single', name: 'uma perda de 650,00', input: { value: '650.00', count: 1, open: 0, withoutValue: 0 }, expected: okOf('650.00', '1', '0') },
  { kind: 'typical', name: 'exemplo do livro: 1.800,00 + 650,00 = 2.450,00, com 1 caso ainda aberto', input: { value: '2450.00', count: 2, open: 1, withoutValue: 0 }, expected: okOf('2450.00', '2', '1') },
  {
    kind: 'period_edge', name: 'perda decidida sem valor: DEGRADED e sem valor', input: { value: '2450.00', count: 3, open: 0, withoutValue: 1 },
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'PERDA_DECIDIDA_SEM_VALOR', count: '3', open: '0', withoutValue: '1' }, dimensions: [{ key: 'casos_qtd', value: '3' }, { key: 'abertos_qtd', value: '0' }, { key: 'sem_valor_qtd', value: '1' }] },
  },
  { kind: 'rounding', name: 'valor com mais de duas casas arredonda uma só vez, meio para cima', input: { value: '0.005', count: 1, open: 0, withoutValue: 0 }, expected: okOf('0.01', '1', '0') },
];

module.exports = { id: 'inv.losses', version: 1, compute, testCases };
