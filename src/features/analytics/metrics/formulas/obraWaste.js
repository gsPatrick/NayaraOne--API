'use strict';

/**
 * M9-D652 — KPI obra.waste (Desperdício), versão 1. Σ do custo das baixas de tipo perda das obras (quantidade perdida × custo médio do dia da baixa,
 * gravado no movimento) até a data-base, por obra e material, e o percentual sobre o consumo valorizado das obras (saídas): desperdício ÷ consumo × 100,
 * 2 casas, arredondado uma só vez. Posição (acumulado da obra até o dia-base), natureza ACTUAL. Entrada (rm_project_waste): { rows: [{ projectId,
 * materialId, wasteValue, withoutCost, consumptionValue }] }. Regra de qualidade: baixa de perda sem custo médio -> DEGRADED, sem valor; consumo zero
 * -> INCOMPLETE (o percentual não existe). Equipe: o movimento de estoque não registra equipe, por isso não há dimensão por equipe (DI-D652-3).
 */
const money = require('./money');
const { degraded, incomplete, sumMoney, groupSum, byKey } = require('./_obraEstoqueKpi');

function dimensionsOf(prefix, waste, consumption) {
  const out = [];
  for (const [id, value] of byKey(waste)) {
    const cons = consumption.get(id) || 0;
    out.push({ key: `${prefix}:${id}`, value: money.money(value) }, { key: `${prefix}:${id}:consumo_brl`, value: money.money(cons) });
    const pct = money.percent(value, cons);
    if (pct.value !== null) out.push({ key: `${prefix}:${id}:desperdicio_pct`, value: pct.value });
  }
  return out;
}

function compute(input) {
  const rows = input.rows || [];
  const without = money.count(money.sum(rows.map((r) => r.withoutCost || 0)));
  const waste = sumMoney(rows.map((r) => r.wasteValue));
  const consumption = sumMoney(rows.map((r) => r.consumptionValue));
  const pct = money.percent(waste, consumption);
  const dimensions = [
    ...dimensionsOf('obra', groupSum(rows, (r) => r.projectId, (r) => r.wasteValue), groupSum(rows, (r) => r.projectId, (r) => r.consumptionValue)),
    ...dimensionsOf('material', groupSum(rows, (r) => r.materialId, (r) => r.wasteValue), groupSum(rows, (r) => r.materialId, (r) => r.consumptionValue)),
    { key: 'consumo_brl', value: money.money(consumption) },
    ...(pct.value === null ? [] : [{ key: 'desperdicio_pct', value: pct.value }]),
  ];
  const details = { consumption: money.money(consumption), percent: pct.value, withoutCost: without };
  if (without !== '0') return degraded('PERDA_SEM_CUSTO_MEDIO', details, dimensions);
  if (pct.value === null) return incomplete('SEM_CONSUMO', details, dimensions);
  return { value: money.money(waste), status: 'OK', details, dimensions };
}

const row = (projectId, materialId, wasteValue, consumptionValue, withoutCost = 0) => ({ projectId, materialId, wasteValue, consumptionValue, withoutCost });
const okOf = (value, consumption, percent, dimensions) => ({ value, status: 'OK', details: { consumption, percent, withoutCost: '0' }, dimensions });
const dims = (...list) => list.map(([key, value]) => ({ key, value }));

const testCases = [
  { kind: 'empty', name: 'nenhuma obra com baixa: INCOMPLETE porque o consumo é zero', input: { rows: [] }, expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'SEM_CONSUMO', consumption: '0.00', percent: null, withoutCost: '0' }, dimensions: dims(['consumo_brl', '0.00']) } },
  {
    kind: 'single', name: 'uma obra e um material: 1.000,00 de perda sobre 10.000,00 de consumo = 10,00%', input: { rows: [row('p1', 'm1', '1000.00', '10000.00')] },
    expected: okOf('1000.00', '10000.00', '10.00', dims(['obra:p1', '1000.00'], ['obra:p1:consumo_brl', '10000.00'], ['obra:p1:desperdicio_pct', '10.00'], ['material:m1', '1000.00'], ['material:m1:consumo_brl', '10000.00'], ['material:m1:desperdicio_pct', '10.00'], ['consumo_brl', '10000.00'], ['desperdicio_pct', '10.00'])),
  },
  {
    kind: 'typical', name: 'exemplo do livro: 14.000,00 de desperdício e 280.000,00 de consumo = 5,00%', input: { rows: [row('p1', 'm1', '9000.00', '200000.00'), row('p1', 'm2', '5000.00', '80000.00')] },
    expected: okOf('14000.00', '280000.00', '5.00', dims(['obra:p1', '14000.00'], ['obra:p1:consumo_brl', '280000.00'], ['obra:p1:desperdicio_pct', '5.00'], ['material:m1', '9000.00'], ['material:m1:consumo_brl', '200000.00'], ['material:m1:desperdicio_pct', '4.50'], ['material:m2', '5000.00'], ['material:m2:consumo_brl', '80000.00'], ['material:m2:desperdicio_pct', '6.25'], ['consumo_brl', '280000.00'], ['desperdicio_pct', '5.00'])),
  },
  {
    kind: 'period_edge', name: 'baixa de perda sem custo médio: DEGRADED e sem valor, mesmo com consumo', input: { rows: [row('p1', 'm1', '50.00', '1000.00', 1)] },
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'PERDA_SEM_CUSTO_MEDIO', consumption: '1000.00', percent: '5.00', withoutCost: '1' }, dimensions: dims(['obra:p1', '50.00'], ['obra:p1:consumo_brl', '1000.00'], ['obra:p1:desperdicio_pct', '5.00'], ['material:m1', '50.00'], ['material:m1:consumo_brl', '1000.00'], ['material:m1:desperdicio_pct', '5.00'], ['consumo_brl', '1000.00'], ['desperdicio_pct', '5.00']) },
  },
  {
    kind: 'rounding', name: 'o percentual arredonda uma só vez, meio para cima (1 de 3 = 33,33%)', input: { rows: [row('p1', 'm1', '1.00', '3.00')] },
    expected: okOf('1.00', '3.00', '33.33', dims(['obra:p1', '1.00'], ['obra:p1:consumo_brl', '3.00'], ['obra:p1:desperdicio_pct', '33.33'], ['material:m1', '1.00'], ['material:m1:consumo_brl', '3.00'], ['material:m1:desperdicio_pct', '33.33'], ['consumo_brl', '3.00'], ['desperdicio_pct', '33.33'])),
  },
];

module.exports = { id: 'obra.waste', version: 1, compute, testCases };
