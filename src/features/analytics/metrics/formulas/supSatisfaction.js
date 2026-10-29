'use strict';

/**
 * M9-D672 — KPI sup.satisfaction (Satisfação, CSAT), versão 1. Fluxo no mês de São Paulo da data-base: CSAT = Σ notas ÷ respostas (nota de 1 a 5, 2 casas) e % de notas 4 ou 5 =
 * (notas >= 4) ÷ respostas × 100 (2 casas), cada um arredondado uma só vez. Menos de minSample respostas (analytics.qualidade.min_amostra) -> INCOMPLETE, valor nulo.
 * Entrada (rm_support_satisfaction): { rows: [{ responses, scoreSum, positive }] }. Contagem de notas 4 ou 5 ainda não calculada pelo read model (nula) -> DEGRADED, valor nulo.
 */
const money = require('./money');
const { degraded, incomplete, sumCounts } = require('./_legalCorKpi');

function compute(input, params = {}) {
  const minSample = Number.isInteger(params.minSample) && params.minSample >= 1 ? params.minSample : 5;
  const rows = (input.rows || []).filter((r) => money.cmp(r.responses || 0, 0) > 0);
  const responses = sumCounts(rows.map((r) => r.responses));
  if (rows.some((r) => r.positive === null || r.positive === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', { responses });
  if (money.cmp(responses, minSample) < 0) return incomplete('AMOSTRA_INSUFICIENTE', { responses, minSample: String(minSample) });
  const scoreSum = sumCounts(rows.map((r) => r.scoreSum));
  const positive = sumCounts(rows.map((r) => r.positive));
  const share = money.percent(positive, responses).value;
  return {
    value: money.round(money.div(scoreSum, responses), 2), status: 'OK', details: { responses, scoreSum, positive, positivePct: share, minSample: String(minSample) },
    dimensions: [{ key: 'respostas_qtd', value: responses }, { key: 'notas_4_5_qtd', value: positive }, { key: 'notas_4_5_pct', value: share }],
  };
}

const row = (responses, scoreSum, positive) => ({ responses, scoreSum, positive });
const okOf = (value, responses, scoreSum, positive, pct) => ({
  value, status: 'OK', details: { responses, scoreSum, positive, positivePct: pct, minSample: '5' },
  dimensions: [{ key: 'respostas_qtd', value: responses }, { key: 'notas_4_5_qtd', value: positive }, { key: 'notas_4_5_pct', value: pct }],
});
const bad = (status, reason, details) => ({ value: null, status, message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhuma resposta no mês: INCOMPLETE e sem valor', params: { minSample: 5 }, input: { rows: [] }, expected: bad('INCOMPLETE', 'AMOSTRA_INSUFICIENTE', { responses: '0', minSample: '5' }) },
  {
    kind: 'single', name: 'uma resposta nota 5 com amostra mínima 1', params: { minSample: 1 }, input: { rows: [row(1, 5, 1)] },
    expected: { ...okOf('5.00', '1', '5', '1', '100.00'), details: { responses: '1', scoreSum: '5', positive: '1', positivePct: '100.00', minSample: '1' } },
  },
  { kind: 'typical', name: 'exemplo da demanda: respostas 5,4,3,5,4 dão 4,20 e 80,00%', params: { minSample: 5 }, input: { rows: [row(5, 21, 4)] }, expected: okOf('4.20', '5', '21', '4', '80.00') },
  { kind: 'period_edge', name: 'quatro respostas com amostra mínima 5: INCOMPLETE e sem valor', params: { minSample: 5 }, input: { rows: [row(4, 17, 3)] }, expected: bad('INCOMPLETE', 'AMOSTRA_INSUFICIENTE', { responses: '4', minSample: '5' }) },
  { kind: 'rounding', name: '3 de 7 notas altas dão 42,86% e 31 pontos em 7 respostas dão 4,43 (meio para cima, uma vez)', params: { minSample: 5 }, input: { rows: [row(7, 31, 3)] }, expected: okOf('4.43', '7', '31', '3', '42.86') },
  { kind: 'period_edge', name: 'notas 4 ou 5 ainda não calculadas pelo read model: DEGRADED e sem valor', params: { minSample: 5 }, input: { rows: [row(5, 21, null)] }, expected: bad('DEGRADED', 'READ_MODEL_NAO_RECALCULADO', { responses: '5' }) },
];

module.exports = { id: 'sup.satisfaction', version: 1, compute, testCases };
