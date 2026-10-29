'use strict';

/**
 * M9-D672 — KPI sup.complaints_by_reason (Reclamações por motivo), versão 1. Fluxo no mês de São Paulo da data-base (abertura): contagem de reclamações por motivo e % de cada
 * motivo sobre o total (2 casas). O valor é o total. Caso sem motivo vai ao motivo SEM_MOTIVO e, acima de maxNoReasonPct por cento do total (parâmetro
 * analytics.qualidade.max_sem_motivo_pct, padrão 5), o KPI sai DEGRADED, valor nulo. Entrada (rm_support_complaints): { rows: [{ reason, count }] }.
 */
const money = require('./money');
const { degraded, exceedsPct, sumCounts, groupCount, byValueDesc } = require('./_legalCorKpi');

const NO_REASON = 'SEM_MOTIVO';

function compute(input, params = {}) {
  const maxPct = Number.isInteger(params.maxNoReasonPct) && params.maxNoReasonPct >= 0 ? params.maxNoReasonPct : 5;
  const byReason = groupCount((input.rows || []).filter((r) => money.cmp(r.count || 0, 0) > 0), (r) => r.reason, (r) => r.count);
  const total = sumCounts([...byReason.values()]);
  const noReason = byReason.get(NO_REASON) || '0';
  if (exceedsPct(noReason, total, maxPct)) return degraded('MOTIVO_AUSENTE_ACIMA_DO_LIMITE', { total, withoutReason: noReason, maxNoReasonPct: String(maxPct) });
  const reasons = byValueDesc(byReason).map(([reason, count]) => ({ reason, count, pct: money.percent(count, total).value }));
  const dimensions = reasons.flatMap((r) => [{ key: `motivo:${r.reason}:qtd`, value: r.count }, { key: `motivo:${r.reason}:pct`, value: r.pct }]);
  return { value: total, status: 'OK', details: { total, withoutReason: noReason, byReason: reasons }, dimensions };
}

const row = (reason, count) => ({ reason, count });
const r = (reason, count, pct) => ({ reason, count, pct });
const okOf = (total, withoutReason, list) => ({ value: total, status: 'OK', details: { total, withoutReason, byReason: list }, dimensions: list.flatMap((x) => [{ key: `motivo:${x.reason}:qtd`, value: x.count }, { key: `motivo:${x.reason}:pct`, value: x.pct }]) });

const testCases = [
  { kind: 'empty', name: 'nenhuma reclamação no mês: total 0', params: { maxNoReasonPct: 5 }, input: { rows: [] }, expected: okOf('0', '0', []) },
  { kind: 'single', name: 'uma reclamação por atraso', params: { maxNoReasonPct: 5 }, input: { rows: [row('ATRASO', 1)] }, expected: okOf('1', '0', [r('ATRASO', '1', '100.00')]) },
  {
    kind: 'typical', name: 'exemplo da demanda: 12 reclamações, 5 por atraso, 4 por atendimento e 3 por cobrança', params: { maxNoReasonPct: 5 },
    input: { rows: [row('COBRANCA', 3), row('ATRASO', 5), row('ATENDIMENTO', 4)] }, expected: okOf('12', '0', [r('ATRASO', '5', '41.67'), r('ATENDIMENTO', '4', '33.33'), r('COBRANCA', '3', '25.00')]),
  },
  {
    kind: 'period_edge', name: 'sem motivo exatamente no limite de 5% não rebaixa; um a mais rebaixa para DEGRADED sem valor', params: { maxNoReasonPct: 5 },
    input: { rows: [row('ATRASO', 19), row(NO_REASON, 1)] }, expected: okOf('20', '1', [r('ATRASO', '19', '95.00'), r(NO_REASON, '1', '5.00')]),
  },
  { kind: 'rounding', name: 'um terço e dois terços arredondam meio para cima (33,33 e 66,67)', params: { maxNoReasonPct: 5 }, input: { rows: [row('A', 1), row('B', 2)] }, expected: okOf('3', '0', [r('B', '2', '66.67'), r('A', '1', '33.33')]) },
  {
    kind: 'period_edge', name: 'sem motivo acima do limite: DEGRADED e sem valor', params: { maxNoReasonPct: 5 }, input: { rows: [row('ATRASO', 18), row(NO_REASON, 2)] },
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'MOTIVO_AUSENTE_ACIMA_DO_LIMITE', total: '20', withoutReason: '2', maxNoReasonPct: '5' }, dimensions: [] },
  },
];

module.exports = { id: 'sup.complaints_by_reason', version: 1, compute, testCases };
