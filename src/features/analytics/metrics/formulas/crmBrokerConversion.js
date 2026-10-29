'use strict';

/**
 * M9-D633 — KPI crm.broker_conversion (Conversão por corretor), versão 1. Mesma regra de crm.conversion_rate (M9-D631): ganhas ÷ (ganhas + perdidas) ×
 * 100 (2 casas, uma vez), decididas pela data de fechamento no período (mês de São Paulo da data-base); desistência não conta. O valor é o da empresa
 * (todos os corretores); cada corretor com pelo menos minSample fechadas entra no ranking (dimensões `corretor:<id>:taxa_pct` e `:fechadas_qtd`), os
 * demais ficam INCOMPLETE em details.brokers (nunca um percentual de amostra pequena). Entrada (rm_crm_outcome/rm_broker_performance nos meses do
 * período): { rows: [{ brokerId, won, lost }] }. Parâmetro: minSample (analytics.qualidade.min_amostra, padrão 5). Empresa com menos de minSample
 * fechadas -> INCOMPLETE, valor nulo.
 */
const money = require('./money');
const { NO_BROKER, incomplete, sumCounts } = require('./_bizKpi');

/** Linhas { brokerId, won, lost }; a reconciliação do detalhe (M9-D611) entrega as oportunidades cruas (stage e owner_user_id), convertidas aqui. */
function rowsOf(input) {
  if (!Array.isArray(input)) return input.rows || [];
  return input.map((r) => ({ brokerId: r.owner_user_id || NO_BROKER, won: r.stage === 'CLOSED_WON' ? 1 : 0, lost: r.stage === 'CLOSED_LOST' ? 1 : 0 }));
}

function perBroker(rows) {
  const map = new Map();
  for (const r of rows) {
    const cur = map.get(r.brokerId) || { won: '0', lost: '0' };
    map.set(r.brokerId, { won: sumCounts([cur.won, r.won]), lost: sumCounts([cur.lost, r.lost]) });
  }
  return map;
}

function compute(input, params = {}) {
  const minSample = Number.isInteger(params.minSample) ? params.minSample : 5;
  const brokers = perBroker(rowsOf(input));
  const won = sumCounts([...brokers.values()].map((b) => b.won));
  const lost = sumCounts([...brokers.values()].map((b) => b.lost));
  const closed = money.count(money.add(won, lost));
  const dimensions = [{ key: 'ganhas_qtd', value: won }, { key: 'perdidas_qtd', value: lost }];
  const list = [];
  for (const id of [...brokers.keys()].sort()) {
    const b = brokers.get(id);
    const bClosed = money.count(money.add(b.won, b.lost));
    if (money.cmp(bClosed, minSample) < 0) { list.push({ brokerId: id, status: 'INCOMPLETE', closed: bClosed }); continue; }
    const rate = money.percent(b.won, bClosed).value;
    list.push({ brokerId: id, status: 'OK', closed: bClosed, ratePct: rate });
    dimensions.push({ key: `corretor:${id}:taxa_pct`, value: rate }, { key: `corretor:${id}:fechadas_qtd`, value: bClosed });
  }
  const details = { won, lost, closed, minSample: String(minSample), brokers: list };
  if (money.cmp(closed, 0) === 0) return incomplete('SEM_FECHADAS', details, dimensions);
  if (money.cmp(closed, minSample) < 0) return incomplete('AMOSTRA_INSUFICIENTE', details, dimensions);
  return { value: money.percent(won, closed).value, status: 'OK', details, dimensions };
}

const row = (brokerId, won, lost) => ({ brokerId, won, lost });
const message = 'Dado incompleto, valor não confiável.';

const testCases = [
  {
    kind: 'empty', name: 'nenhuma fechada no período: denominador zero => INCOMPLETE e sem valor', input: { rows: [] },
    expected: { value: null, status: 'INCOMPLETE', message, details: { reason: 'SEM_FECHADAS', won: '0', lost: '0', closed: '0', minSample: '5', brokers: [] }, dimensions: [{ key: 'ganhas_qtd', value: '0' }, { key: 'perdidas_qtd', value: '0' }] },
  },
  {
    kind: 'single', name: 'um corretor com 1 ganha: amostra menor que o mínimo => INCOMPLETE para ele e para a empresa', input: { rows: [row('b1', 1, 0)] },
    expected: { value: null, status: 'INCOMPLETE', message, details: { reason: 'AMOSTRA_INSUFICIENTE', won: '1', lost: '0', closed: '1', minSample: '5', brokers: [{ brokerId: 'b1', status: 'INCOMPLETE', closed: '1' }] }, dimensions: [{ key: 'ganhas_qtd', value: '1' }, { key: 'perdidas_qtd', value: '0' }] },
  },
  {
    kind: 'typical', name: 'exemplo do livro: Ana 7 ganhas e 13 perdidas => 35,00%; Bruno com 3 fechadas fica INCOMPLETE no ranking', input: { rows: [row('ana', 7, 13), row('bruno', 1, 2)] },
    expected: {
      value: '34.78', status: 'OK',
      details: { won: '8', lost: '15', closed: '23', minSample: '5', brokers: [{ brokerId: 'ana', status: 'OK', closed: '20', ratePct: '35.00' }, { brokerId: 'bruno', status: 'INCOMPLETE', closed: '3' }] },
      dimensions: [{ key: 'ganhas_qtd', value: '8' }, { key: 'perdidas_qtd', value: '15' }, { key: 'corretor:ana:taxa_pct', value: '35.00' }, { key: 'corretor:ana:fechadas_qtd', value: '20' }],
    },
  },
  {
    kind: 'period_edge', name: 'exatamente no mínimo (5 fechadas) entra; o mesmo corretor em dois meses soma', input: { rows: [row('b1', 1, 1), row('b1', 1, 2)] },
    expected: { value: '40.00', status: 'OK', details: { won: '2', lost: '3', closed: '5', minSample: '5', brokers: [{ brokerId: 'b1', status: 'OK', closed: '5', ratePct: '40.00' }] }, dimensions: [{ key: 'ganhas_qtd', value: '2' }, { key: 'perdidas_qtd', value: '3' }, { key: 'corretor:b1:taxa_pct', value: '40.00' }, { key: 'corretor:b1:fechadas_qtd', value: '5' }] },
  },
  {
    kind: 'rounding', name: 'taxa 1 de 6 arredonda uma vez, meio para cima: 16,67%', input: { rows: [row('b1', 1, 5)] },
    expected: { value: '16.67', status: 'OK', details: { won: '1', lost: '5', closed: '6', minSample: '5', brokers: [{ brokerId: 'b1', status: 'OK', closed: '6', ratePct: '16.67' }] }, dimensions: [{ key: 'ganhas_qtd', value: '1' }, { key: 'perdidas_qtd', value: '5' }, { key: 'corretor:b1:taxa_pct', value: '16.67' }, { key: 'corretor:b1:fechadas_qtd', value: '6' }] },
  },
  {
    kind: 'period_edge', name: 'amostra mínima configurável: com minSample 2, 3 fechadas já formam ranking', input: { rows: [row('b1', 1, 2)] }, params: { minSample: 2 },
    expected: { value: '33.33', status: 'OK', details: { won: '1', lost: '2', closed: '3', minSample: '2', brokers: [{ brokerId: 'b1', status: 'OK', closed: '3', ratePct: '33.33' }] }, dimensions: [{ key: 'ganhas_qtd', value: '1' }, { key: 'perdidas_qtd', value: '2' }, { key: 'corretor:b1:taxa_pct', value: '33.33' }, { key: 'corretor:b1:fechadas_qtd', value: '3' }] },
  },
];

module.exports = { id: 'crm.broker_conversion', version: 1, compute, testCases };
