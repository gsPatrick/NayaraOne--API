'use strict';

/**
 * M9-D631 — KPI crm.loss_reasons (Motivos de perda), versão 1. Contagem das oportunidades CLOSED_LOST fechadas no mês de São Paulo da data-base, por
 * motivo (mesmo agrupamento de getCrmDashboard), com o percentual de cada motivo (2 casas, uma vez). O total é o número de perdidas; perdida sem
 * motivo vai a NAO_INFORMADO ("Sem motivo"). Entrada (rm_crm_outcome no mês): { lostTotal, reasons: [{ reason, brokerId, count }] }.
 * Parâmetro: maxNoReasonPct. Regra de qualidade: "Sem motivo" acima do limite, ou motivos que não somam o total de perdidas -> DEGRADED, valor nulo.
 */
const money = require('./money');
const { degraded, exceedsPct, groupSum, byValueDesc, NO_REASON } = require('./_crmKpi');

function compute(input, params = {}) {
  const maxNoReasonPct = Number.isInteger(params.maxNoReasonPct) ? params.maxNoReasonPct : 5;
  const reasons = input.reasons || [];
  const total = money.count(input.lostTotal || 0);
  const byReason = groupSum(reasons, (r) => String(r.reason || '').trim().toUpperCase() || NO_REASON, (r) => r.count);
  const byBroker = groupSum(reasons, (r) => r.brokerId, (r) => r.count);
  const summed = money.count(money.sum([...byReason.values()]));
  const noReason = byReason.get(NO_REASON) || '0';
  const list = byValueDesc(byReason).map(([reason, count]) => ({ reason, count: money.count(count), percent: money.percent(count, total).value }));
  const dimensions = [];
  for (const r of list) {
    dimensions.push({ key: `motivo:${r.reason}`, value: r.count });
    if (r.percent !== null) dimensions.push({ key: `motivo:${r.reason}:parte_pct`, value: r.percent });
  }
  for (const [broker, count] of [...byBroker.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) dimensions.push({ key: `corretor:${broker}`, value: money.count(count) });
  const details = { total, byReason: list, withoutReason: money.count(noReason), withoutReasonPct: money.percent(noReason, total).value };
  if (money.cmp(summed, total) !== 0) return degraded('MOTIVOS_NAO_FECHAM_COM_O_TOTAL', { ...details, summed }, dimensions);
  if (money.cmp(total, 0) > 0 && exceedsPct(noReason, total, maxNoReasonPct)) return degraded('SEM_MOTIVO_ACIMA_DO_LIMITE', { ...details, maxNoReasonPct: String(maxNoReasonPct) }, dimensions);
  return { value: total, status: 'OK', details, dimensions };
}

const reason = (name, count, brokerId = 'b1') => ({ reason: name, brokerId, count });
const r = (name, count, percent) => ({ reason: name, count, percent });
const dims = (list, brokers) => [...list.flatMap((x) => [{ key: `motivo:${x.reason}`, value: x.count }, { key: `motivo:${x.reason}:parte_pct`, value: x.percent }]), ...brokers.map(([id, n]) => ({ key: `corretor:${id}`, value: n }))];
const ok = (total, list, noReason, noReasonPct, brokers) => ({ value: total, status: 'OK', details: { total, byReason: list, withoutReason: noReason, withoutReasonPct: noReasonPct }, dimensions: dims(list, brokers) });

const testCases = [
  { kind: 'empty', name: 'nenhuma perdida no mês: total 0, sem motivos', input: { lostTotal: 0, reasons: [] }, expected: { value: '0', status: 'OK', details: { total: '0', byReason: [], withoutReason: '0', withoutReasonPct: null }, dimensions: [] } },
  { kind: 'single', name: 'uma perdida por preço: 100,00%', input: { lostTotal: 1, reasons: [reason('PRICE', 1)] }, expected: ok('1', [r('PRICE', '1', '100.00')], '0', '0.00', [['b1', '1']]) },
  {
    kind: 'typical', name: 'exemplo da demanda: 14 perdidas, preço 6, desistência 5, sem motivo 3 (limite elevado a 25%)', params: { maxNoReasonPct: 25 },
    input: { lostTotal: 14, reasons: [reason('PRICE', 6, 'b1'), reason('CLIENT_GAVE_UP', 5, 'b2'), reason('NAO_INFORMADO', 3, 'b1')] },
    expected: ok('14', [r('PRICE', '6', '42.86'), r('CLIENT_GAVE_UP', '5', '35.71'), r('NAO_INFORMADO', '3', '21.43')], '3', '21.43', [['b1', '9'], ['b2', '5']]),
  },
  {
    kind: 'period_edge', name: 'sem motivo acima de 5% (3 de 14): DEGRADED e sem valor', input: { lostTotal: 14, reasons: [reason('PRICE', 6), reason('CLIENT_GAVE_UP', 5), reason('', 3)] },
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.',
      details: { reason: 'SEM_MOTIVO_ACIMA_DO_LIMITE', total: '14', byReason: [r('PRICE', '6', '42.86'), r('CLIENT_GAVE_UP', '5', '35.71'), r('NAO_INFORMADO', '3', '21.43')], withoutReason: '3', withoutReasonPct: '21.43', maxNoReasonPct: '5' },
      dimensions: dims([r('PRICE', '6', '42.86'), r('CLIENT_GAVE_UP', '5', '35.71'), r('NAO_INFORMADO', '3', '21.43')], [['b1', '14']]),
    },
  },
  {
    kind: 'rounding', name: 'três motivos iguais: 33,33% cada', input: { lostTotal: 3, reasons: [reason('A', 1), reason('B', 1), reason('C', 1)] },
    expected: ok('3', [r('A', '1', '33.33'), r('B', '1', '33.33'), r('C', '1', '33.33')], '0', '0.00', [['b1', '3']]),
  },
  {
    kind: 'rounding', name: 'motivos que não somam o total de perdidas: DEGRADED (o percentual não seria confiável)', input: { lostTotal: 4, reasons: [reason('A', 1), reason('B', 2)] },
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.',
      details: { reason: 'MOTIVOS_NAO_FECHAM_COM_O_TOTAL', total: '4', byReason: [r('B', '2', '50.00'), r('A', '1', '25.00')], withoutReason: '0', withoutReasonPct: '0.00', summed: '3' },
      dimensions: dims([r('B', '2', '50.00'), r('A', '1', '25.00')], [['b1', '3']]),
    },
  },
];

module.exports = { id: 'crm.loss_reasons', version: 1, compute, testCases };
