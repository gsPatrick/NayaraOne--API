'use strict';

/**
 * M9-D631 — KPI crm.conversion_rate (Conversão), versão 1. Conversão = ganhas / (ganhas + perdidas) x 100 (2 casas, uma vez), no mês de São Paulo da
 * data-base, onde ganha e perdida são decididas pela data de fechamento. Desistência (WITHDRAWN) não conta: não é decisão do cliente. Entrada (linhas
 * de totais do rm_crm_outcome no mês): { rows: [{ brokerId, won, lost }] }. Parâmetro: minSample. Regra de qualidade: nenhuma fechada, ou menos de
 * minSample fechadas, -> INCOMPLETE, valor nulo (denominador zero nunca vira 0%). A reconciliação com o detalhe (M9-D611) entrega as próprias
 * oportunidades fechadas ([{ stage }]) e a fórmula refaz a taxa sobre elas.
 */
const money = require('./money');
const { incomplete, groupSum } = require('./_crmKpi');

function brokerDimensions(rows) {
  const won = groupSum(rows, (r) => r.brokerId, (r) => r.won);
  const lost = groupSum(rows, (r) => r.brokerId, (r) => r.lost);
  const out = [];
  for (const broker of [...won.keys()].sort()) {
    const closed = money.toString(money.add(won.get(broker), lost.get(broker) || 0));
    if (money.cmp(closed, 0) === 0) continue;
    out.push({ key: `corretor:${broker}:taxa_pct`, value: money.percent(won.get(broker), closed).value }, { key: `corretor:${broker}:fechadas_qtd`, value: money.count(closed) });
  }
  return out;
}

/** Linhas-fonte da reconciliação (M9-D611, RECOMPUTE): cada oportunidade fechada vira uma ganha ou uma perdida pelo estágio. */
const fromSourceRows = (list) => list.map((r) => ({ brokerId: '-', won: r.stage === 'WON' ? 1 : 0, lost: r.stage === 'LOST' ? 1 : 0 }));

function compute(input, params = {}) {
  const minSample = Number.isInteger(params.minSample) ? params.minSample : 5;
  const rows = Array.isArray(input) ? fromSourceRows(input) : input.rows || [];
  const won = money.count(money.sum(rows.map((r) => r.won || 0)));
  const lost = money.count(money.sum(rows.map((r) => r.lost || 0)));
  const closed = money.count(money.add(won, lost));
  const details = { won, lost, closed, minSample: String(minSample) };
  const dimensions = [{ key: 'ganhas_qtd', value: won }, { key: 'perdidas_qtd', value: lost }];
  if (money.cmp(closed, 0) === 0) return incomplete('SEM_FECHADAS', details, dimensions);
  if (money.cmp(closed, minSample) < 0) return incomplete('AMOSTRA_INSUFICIENTE', details, dimensions);
  dimensions.push(...brokerDimensions(rows));
  return { value: money.percent(won, closed).value, status: 'OK', details, dimensions };
}

const row = (won, lost, brokerId = 'b1') => ({ brokerId, won, lost });
const none = (reason, won, lost, minSample = '5') => ({
  value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.',
  details: { reason, won, lost, closed: String(Number.parseInt(won, 10) + Number.parseInt(lost, 10)), minSample }, dimensions: [{ key: 'ganhas_qtd', value: won }, { key: 'perdidas_qtd', value: lost }],
});
const ok = (value, won, lost, brokerDims, minSample = '5') => ({
  value, status: 'OK', details: { won, lost, closed: String(Number.parseInt(won, 10) + Number.parseInt(lost, 10)), minSample },
  dimensions: [{ key: 'ganhas_qtd', value: won }, { key: 'perdidas_qtd', value: lost }, ...brokerDims],
});

const testCases = [
  { kind: 'empty', name: 'nenhuma fechada no mês: denominador zero => INCOMPLETE e sem valor', input: { rows: [] }, expected: none('SEM_FECHADAS', '0', '0') },
  { kind: 'single', name: 'uma ganha só: amostra menor que o mínimo => INCOMPLETE', input: { rows: [row(1, 0)] }, expected: none('AMOSTRA_INSUFICIENTE', '1', '0') },
  {
    kind: 'typical', name: 'exemplo da demanda: 6 ganhas e 14 perdidas => 30,00%', input: { rows: [row(4, 6, 'b1'), row(2, 8, 'b2')] },
    expected: ok('30.00', '6', '14', [
      { key: 'corretor:b1:taxa_pct', value: '40.00' }, { key: 'corretor:b1:fechadas_qtd', value: '10' }, { key: 'corretor:b2:taxa_pct', value: '20.00' }, { key: 'corretor:b2:fechadas_qtd', value: '10' },
    ]),
  },
  {
    kind: 'period_edge', name: 'o mínimo de fechadas é configurável: 2 fechadas bastam com mínimo 2', params: { minSample: 2 }, input: { rows: [row(1, 1)] },
    expected: ok('50.00', '1', '1', [{ key: 'corretor:b1:taxa_pct', value: '50.00' }, { key: 'corretor:b1:fechadas_qtd', value: '2' }], '2'),
  },
  {
    kind: 'typical', name: 'linhas-fonte da reconciliação: 6 WON e 14 LOST => 30,00%', params: { minSample: 1 },
    input: [...Array(6).fill({ stage: 'WON' }), ...Array(14).fill({ stage: 'LOST' })],
    expected: ok('30.00', '6', '14', [{ key: 'corretor:-:taxa_pct', value: '30.00' }, { key: 'corretor:-:fechadas_qtd', value: '20' }], '1'),
  },
  { kind: 'rounding', name: '1 ganha em 3 fechadas => 33,33% (meio para cima, 2 casas)', params: { minSample: 3 }, input: { rows: [row(1, 2)] }, expected: ok('33.33', '1', '2', [{ key: 'corretor:b1:taxa_pct', value: '33.33' }, { key: 'corretor:b1:fechadas_qtd', value: '3' }], '3') },
  { kind: 'rounding', name: '2 ganhas em 3 fechadas => 66,67%', params: { minSample: 3 }, input: { rows: [row(2, 1)] }, expected: ok('66.67', '2', '1', [{ key: 'corretor:b1:taxa_pct', value: '66.67' }, { key: 'corretor:b1:fechadas_qtd', value: '3' }], '3') },
];

module.exports = { id: 'crm.conversion_rate', version: 1, compute, testCases };
