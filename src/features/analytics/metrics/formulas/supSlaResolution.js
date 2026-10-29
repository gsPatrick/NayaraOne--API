'use strict';

/**
 * M9-D672 — KPI sup.sla_resolution (SLA de resolução), versão 1. Fluxo no mês de São Paulo da data-base: % dentro do SLA = casos resolvidos no mês com (resolução − abertura) no
 * SLA da prioridade (analytics.sla.horas.<prioridade>) ÷ casos resolvidos × 100, 2 casas; casos em aberto já vencidos em details.openOverdue e na dimensão abertos_vencidos_qtd.
 * Entrada (rm_support_sla): { resolved, within, openOverdue, withoutPriority, priorities: { ALTA|MEDIA|BAIXA: { resolved, within } } }. Caso resolvido sem prioridade foi medido
 * pela prioridade padrão MEDIA e rebaixa a qualidade -> DEGRADED, valor nulo; contagens por prioridade ainda não calculadas pelo read model (nulas) -> DEGRADED; nenhum caso
 * resolvido no mês -> INCOMPLETE. Valor sempre nulo nesses casos.
 */
const money = require('./money');
const { degraded, incomplete } = require('./_legalCorKpi');

const PRIORITIES = ['ALTA', 'MEDIA', 'BAIXA'];

function compute(input) {
  const resolved = money.count(input.resolved || 0);
  const within = money.count(input.within || 0);
  const openOverdue = money.count(input.openOverdue || 0);
  const base = { resolved, openOverdue };
  const priorities = input.priorities || {};
  const missing = input.withoutPriority === null || input.withoutPriority === undefined || PRIORITIES.some((p) => !priorities[p] || priorities[p].resolved === null || priorities[p].resolved === undefined);
  if (missing) return degraded('READ_MODEL_NAO_RECALCULADO', base);
  const withoutPriority = money.count(input.withoutPriority);
  if (money.cmp(withoutPriority, 0) > 0) return degraded('CASO_SEM_PRIORIDADE', { ...base, withoutPriority });
  if (money.cmp(resolved, 0) === 0) return incomplete('SEM_CASO_RESOLVIDO_NO_PERIODO', base);
  const byPriority = PRIORITIES.map((p) => {
    const own = { resolved: money.count(priorities[p].resolved), within: money.count(priorities[p].within || 0) };
    return { priority: p, ...own, pct: money.cmp(own.resolved, 0) > 0 ? money.percent(own.within, own.resolved).value : null };
  });
  const dimensions = [{ key: 'resolvidos_qtd', value: resolved }, { key: 'dentro_do_sla_qtd', value: within }, { key: 'abertos_vencidos_qtd', value: openOverdue }];
  for (const p of byPriority) {
    dimensions.push({ key: `prioridade:${p.priority}:resolvidos_qtd`, value: p.resolved }, { key: `prioridade:${p.priority}:dentro_qtd`, value: p.within });
    if (p.pct !== null) dimensions.push({ key: `prioridade:${p.priority}:dentro_pct`, value: p.pct });
  }
  return { value: money.percent(within, resolved).value, status: 'OK', details: { resolved, within, openOverdue, byPriority }, dimensions };
}

const pr = (a, b, c, d, e, f) => ({ ALTA: { resolved: a, within: b }, MEDIA: { resolved: c, within: d }, BAIXA: { resolved: e, within: f } });
const mk = (resolved, within, openOverdue, priorities, withoutPriority = 0) => ({ resolved, within, openOverdue, withoutPriority, priorities });
const lvl = (priority, resolved, within, pct) => ({ priority, resolved, within, pct });
const okOf = (value, byPriority, resolved, within, openOverdue) => ({
  value, status: 'OK', details: { resolved, within, openOverdue, byPriority },
  dimensions: [{ key: 'resolvidos_qtd', value: resolved }, { key: 'dentro_do_sla_qtd', value: within }, { key: 'abertos_vencidos_qtd', value: openOverdue },
    ...byPriority.flatMap((p) => [{ key: `prioridade:${p.priority}:resolvidos_qtd`, value: p.resolved }, { key: `prioridade:${p.priority}:dentro_qtd`, value: p.within }, ...(p.pct === null ? [] : [{ key: `prioridade:${p.priority}:dentro_pct`, value: p.pct }])])],
});
const bad = (status, reason, details) => ({ value: null, status, message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhum caso resolvido no mês: INCOMPLETE e sem valor, vencidos em aberto à parte', input: mk(0, 0, 2, pr(0, 0, 0, 0, 0, 0)), expected: bad('INCOMPLETE', 'SEM_CASO_RESOLVIDO_NO_PERIODO', { resolved: '0', openOverdue: '2' }) },
  { kind: 'single', name: 'um caso resolvido dentro do SLA', input: mk(1, 1, 0, pr(0, 0, 1, 1, 0, 0)), expected: okOf('100.00', [lvl('ALTA', '0', '0', null), lvl('MEDIA', '1', '1', '100.00'), lvl('BAIXA', '0', '0', null)], '1', '1', '0') },
  { kind: 'typical', name: 'exemplo da demanda: 44 resolvidos, 40 dentro do SLA dão 90,91%', input: mk(44, 40, 3, pr(10, 9, 24, 22, 10, 9)), expected: okOf('90.91', [lvl('ALTA', '10', '9', '90.00'), lvl('MEDIA', '24', '22', '91.67'), lvl('BAIXA', '10', '9', '90.00')], '44', '40', '3') },
  { kind: 'rounding', name: '5 de 7 dentro do SLA dão 71,43% (meio para cima, uma só vez)', input: mk(7, 5, 1, pr(2, 1, 3, 2, 2, 2)), expected: okOf('71.43', [lvl('ALTA', '2', '1', '50.00'), lvl('MEDIA', '3', '2', '66.67'), lvl('BAIXA', '2', '2', '100.00')], '7', '5', '1') },
  { kind: 'period_edge', name: 'caso resolvido sem prioridade (medido como MEDIA): DEGRADED e sem valor', input: mk(3, 3, 1, pr(1, 1, 2, 2, 0, 0), 1), expected: bad('DEGRADED', 'CASO_SEM_PRIORIDADE', { resolved: '3', openOverdue: '1', withoutPriority: '1' }) },
  { kind: 'period_edge', name: 'contagens por prioridade ainda não calculadas pelo read model: DEGRADED e sem valor', input: { resolved: 3, within: 3, openOverdue: 0, withoutPriority: null, priorities: pr(null, null, null, null, null, null) }, expected: bad('DEGRADED', 'READ_MODEL_NAO_RECALCULADO', { resolved: '3', openOverdue: '0' }) },
];

module.exports = { id: 'sup.sla_resolution', version: 1, compute, testCases };
