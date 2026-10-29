'use strict';

/**
 * M9-D633 — KPI crm.broker_capture (Captação por corretor), versão 1. Valor = imóveis captados no período (cadastro em São Paulo, mês de calendário),
 * com um número por corretor e "Sem captador" à parte. O valor médio pedido dos captados (reais, natureza ESTIMATED; oferta ativa do imóvel, a de
 * venda tem preferência) = soma ÷ quantos têm valor, 2 casas, uma vez. Entrada (rm_broker_performance nos meses do período): { rows: [{ brokerId,
 * captured, withValue, valueSum }] }. Parâmetro: maxNoBrokerPct (analytics.qualidade.max_sem_corretor_pct, padrão 5). Regra de qualidade: "Sem
 * captador" acima do limite -> DEGRADED, valor nulo.
 */
const money = require('./money');
const { NO_BROKER, degraded, sumCounts } = require('./_bizKpi');

const average = (sum, n) => (n === '0' ? null : money.money(money.div(sum, n)));

function compute(input, params = {}) {
  const maxPct = Number.isInteger(params.maxNoBrokerPct) ? params.maxNoBrokerPct : 5;
  const rows = input.rows || [];
  const byBroker = new Map();
  for (const r of rows) {
    const cur = byBroker.get(r.brokerId) || { captured: '0', withValue: '0', valueSum: '0' };
    byBroker.set(r.brokerId, { captured: sumCounts([cur.captured, r.captured]), withValue: sumCounts([cur.withValue, r.withValue]), valueSum: money.toString(money.add(cur.valueSum, r.valueSum || 0)) });
  }
  const total = sumCounts([...byBroker.values()].map((b) => b.captured));
  const noBroker = (byBroker.get(NO_BROKER) || { captured: '0' }).captured;
  const withValue = sumCounts([...byBroker.values()].map((b) => b.withValue));
  const valueSum = money.toString(money.sum([...byBroker.values()].map((b) => b.valueSum)));
  const mean = average(valueSum, withValue);
  const dimensions = [{ key: 'sem_captador', value: noBroker }];
  if (mean !== null) dimensions.push({ key: 'valor_medio_brl', value: mean });
  for (const id of [...byBroker.keys()].filter((k) => k !== NO_BROKER).sort()) {
    const b = byBroker.get(id);
    dimensions.push({ key: `corretor:${id}:captados`, value: b.captured });
    const m = average(b.valueSum, b.withValue);
    if (m !== null) dimensions.push({ key: `corretor:${id}:valor_medio_brl`, value: m });
  }
  const details = { total, noBroker, noBrokerLimitPct: String(maxPct), averageValue: mean };
  if (money.cmp(money.mul(noBroker, 100), money.mul(maxPct, total)) > 0) return degraded('SEM_CAPTADOR_ACIMA_DO_LIMITE', details, dimensions);
  return { value: total, status: 'OK', details, dimensions };
}

const row = (brokerId, captured, withValue, valueSum) => ({ brokerId, captured, withValue, valueSum });
const okOf = (total, noBroker, mean, dims) => ({ value: total, status: 'OK', details: { total, noBroker, noBrokerLimitPct: '5', averageValue: mean }, dimensions: [{ key: 'sem_captador', value: noBroker }, ...(mean === null ? [] : [{ key: 'valor_medio_brl', value: mean }]), ...dims] });

const testCases = [
  { kind: 'empty', name: 'nenhum imóvel captado: zero, sem valor médio', input: { rows: [] }, expected: okOf('0', '0', null, []) },
  { kind: 'single', name: 'um captado com valor', input: { rows: [row('b1', 1, 1, '500000.00')] }, expected: okOf('1', '0', '500000.00', [{ key: 'corretor:b1:captados', value: '1' }, { key: 'corretor:b1:valor_medio_brl', value: '500000.00' }]) },
  {
    kind: 'typical', name: 'exemplo do livro: Ana 6, Bruno 4, Sem captador 1 (9,09% é acima do limite padrão: DEGRADED)', input: { rows: [row('ana', 6, 6, '3000000.00'), row('bruno', 4, 2, '800000.00'), row(NO_BROKER, 1, 0, '0')] },
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'SEM_CAPTADOR_ACIMA_DO_LIMITE', total: '11', noBroker: '1', noBrokerLimitPct: '5', averageValue: '475000.00' },
      dimensions: [{ key: 'sem_captador', value: '1' }, { key: 'valor_medio_brl', value: '475000.00' }, { key: 'corretor:ana:captados', value: '6' }, { key: 'corretor:ana:valor_medio_brl', value: '500000.00' }, { key: 'corretor:bruno:captados', value: '4' }, { key: 'corretor:bruno:valor_medio_brl', value: '400000.00' }],
    },
  },
  {
    kind: 'typical', name: 'mesmo exemplo com limite de 10%: passa, e o mesmo corretor em dois meses soma', input: { rows: [row('ana', 3, 3, '1500000.00'), row('ana', 3, 3, '1500000.00'), row('bruno', 4, 2, '800000.00'), row(NO_BROKER, 1, 0, '0')] }, params: { maxNoBrokerPct: 10 },
    expected: { value: '11', status: 'OK', details: { total: '11', noBroker: '1', noBrokerLimitPct: '10', averageValue: '475000.00' }, dimensions: [{ key: 'sem_captador', value: '1' }, { key: 'valor_medio_brl', value: '475000.00' }, { key: 'corretor:ana:captados', value: '6' }, { key: 'corretor:ana:valor_medio_brl', value: '500000.00' }, { key: 'corretor:bruno:captados', value: '4' }, { key: 'corretor:bruno:valor_medio_brl', value: '400000.00' }] },
  },
  { kind: 'period_edge', name: 'exatamente no limite (1 de 20 = 5%) passa; só acima é DEGRADED', input: { rows: [row('b1', 19, 0, '0'), row(NO_BROKER, 1, 0, '0')] }, expected: okOf('20', '1', null, [{ key: 'corretor:b1:captados', value: '19' }]) },
  { kind: 'rounding', name: 'valor médio arredonda uma vez, meio para cima: 100,005 vira 100,01', input: { rows: [row('b1', 2, 2, '200.01')] }, expected: okOf('2', '0', '100.01', [{ key: 'corretor:b1:captados', value: '2' }, { key: 'corretor:b1:valor_medio_brl', value: '100.01' }]) },
];

module.exports = { id: 'crm.broker_capture', version: 1, compute, testCases };
