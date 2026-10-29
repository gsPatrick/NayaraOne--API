'use strict';

/**
 * M9-D661 — KPI cor.analysis_time (Tempo de análise), versão 1. Média dos dias de calendário de São Paulo entre o envio ao provider e a decisão,
 * só dos casos decididos no mês da data-base, com 1 casa (arredondada uma só vez). Casos enviados e ainda sem decisão ficam em details.pending
 * (estágios do parâmetro analytics.correspondente.estagios_em_analise). Entrada: { rows: [{ provider, product, approved, rejected, analysisCount,
 * daysSum }], pending }. Regra de qualidade: decisão sem data de envio -> DEGRADED; soma de dias ainda não calculada pelo read model (nula) ->
 * DEGRADED; nenhuma decisão com envio no mês -> INCOMPLETE. Valor sempre nulo nesses casos.
 */
const money = require('./money');
const { degraded, incomplete, sumCounts, byText } = require('./_legalCorKpi');

function compute(input) {
  const rows = input.rows || [];
  const pending = money.count(input.pending || 0);
  const decided = sumCounts(rows.map((r) => money.add(r.approved || 0, r.rejected || 0)));
  const analysed = sumCounts(rows.map((r) => r.analysisCount));
  const base = { decided, withSendDate: analysed, pending };
  if (rows.some((r) => money.cmp(r.analysisCount || 0, 0) > 0 && (r.daysSum === null || r.daysSum === undefined))) return degraded('READ_MODEL_NAO_RECALCULADO', base);
  if (money.cmp(decided, analysed) > 0) return degraded('ENVIO_SEM_DATA', { ...base, withoutSendDate: money.count(money.sub(decided, analysed)) });
  if (money.cmp(analysed, 0) === 0) return incomplete('SEM_DECISAO_NO_PERIODO', base);
  const average = (list) => money.round(money.div(sumCounts(list.map((r) => r.daysSum)), sumCounts(list.map((r) => r.analysisCount))), 1);
  const providers = [...new Set(rows.filter((r) => money.cmp(r.analysisCount || 0, 0) > 0).map((r) => r.provider))].sort(byText);
  const byProvider = providers.map((provider) => ({ provider, averageDays: average(rows.filter((r) => r.provider === provider)) }));
  const value = average(rows);
  return { value, status: 'OK', details: { ...base, byProvider }, dimensions: [{ key: 'decididos_qtd', value: decided }, { key: 'pendentes_qtd', value: pending }, ...byProvider.map((p) => ({ key: `provider:${p.provider}:media_dias`, value: p.averageDays }))] };
}

const row = (provider, approved, rejected, analysisCount, daysSum) => ({ provider, product: 'FINANCIAMENTO', approved, rejected, analysisCount, daysSum });
const okOf = (value, decided, sent, pending, byProvider) => ({
  value, status: 'OK', details: { decided, withSendDate: sent, pending, byProvider },
  dimensions: [{ key: 'decididos_qtd', value: decided }, { key: 'pendentes_qtd', value: pending }, ...byProvider.map((x) => ({ key: `provider:${x.provider}:media_dias`, value: x.averageDays }))],
});
const bad = (status, reason, details) => ({ value: null, status, message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhuma decisão no mês: INCOMPLETE e sem valor', input: { rows: [], pending: 2 }, expected: bad('INCOMPLETE', 'SEM_DECISAO_NO_PERIODO', { decided: '0', withSendDate: '0', pending: '2' }) },
  { kind: 'single', name: 'uma decisão em 3 dias', input: { rows: [row('BANCO_A', 1, 0, 1, 3)], pending: 0 }, expected: okOf('3.0', '1', '1', '0', [{ provider: 'BANCO_A', averageDays: '3.0' }]) },
  {
    kind: 'typical', name: 'exemplo da demanda: média de 6,5 dias (13 dias em 2 decisões), pendentes à parte', input: { rows: [row('BANCO_A', 1, 1, 2, 13)], pending: 4 },
    expected: okOf('6.5', '2', '2', '4', [{ provider: 'BANCO_A', averageDays: '6.5' }]),
  },
  {
    kind: 'period_edge', name: 'média geral pesa pelas decisões, não pela média dos providers: (1+1+10)/3 = 4,0 e A=1,0 / B=10,0', input: { rows: [row('BANCO_A', 2, 0, 2, 2), row('BANCO_B', 0, 1, 1, 10)], pending: 0 },
    expected: okOf('4.0', '3', '3', '0', [{ provider: 'BANCO_A', averageDays: '1.0' }, { provider: 'BANCO_B', averageDays: '10.0' }]),
  },
  { kind: 'rounding', name: 'média com dízima arredonda uma vez: 10 dias em 3 decisões = 3,3; 5 em 8 = 0,6', input: { rows: [row('BANCO_A', 3, 0, 3, 10)], pending: 0 }, expected: okOf('3.3', '3', '3', '0', [{ provider: 'BANCO_A', averageDays: '3.3' }]) },
  {
    kind: 'period_edge', name: 'decisão sem data de envio: DEGRADED e sem valor', input: { rows: [row('BANCO_A', 2, 0, 1, 4)], pending: 0 },
    expected: bad('DEGRADED', 'ENVIO_SEM_DATA', { decided: '2', withSendDate: '1', pending: '0', withoutSendDate: '1' }),
  },
  { kind: 'period_edge', name: 'soma de dias ainda não calculada pelo read model: DEGRADED', input: { rows: [row('BANCO_A', 1, 0, 1, null)], pending: 0 }, expected: bad('DEGRADED', 'READ_MODEL_NAO_RECALCULADO', { decided: '1', withSendDate: '1', pending: '0' }) },
];

module.exports = { id: 'cor.analysis_time', version: 1, compute, testCases };
