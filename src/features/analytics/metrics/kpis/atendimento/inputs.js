'use strict';

/**
 * M9-D672 — entrada de cada fórmula dos KPIs de Atendimento a partir das linhas dos read models (rows) e os parâmetros que a fórmula recebe. Mapeamento puro (sem banco):
 * os números chegam como inteiros e a fórmula faz a conta em decimal exato. Mês sem linha do SLA é mês sem casos: tudo zero.
 */
const notes = (r) => [r.r1, r.r2, r.r3, r.r4, r.r5];
const level = (sla, p) => ({ resolved: sla[`resolved_${p}`], within: sla[`within_${p}`] });

function slaInput(sla) {
  if (!sla) return { resolved: 0, within: 0, openOverdue: 0, withoutPriority: 0, priorities: { ALTA: { resolved: 0, within: 0 }, MEDIA: { resolved: 0, within: 0 }, BAIXA: { resolved: 0, within: 0 } } };
  return { resolved: sla.resolved, within: sla.withinSla, openOverdue: sla.openOverdue, withoutPriority: sla.withoutPriority, priorities: { ALTA: level(sla, 'alta'), MEDIA: level(sla, 'media'), BAIXA: level(sla, 'baixa') } };
}

const INPUTS = Object.freeze({
  'sup.reviews': (r) => ({ rows: r.reviews.map((x) => ({ platform: x.platform, reviews: x.reviews, ratingSum: x.ratingSum, ratings: notes(x) })) }),
  'sup.satisfaction': (r) => ({ rows: r.satisfaction }),
  'sup.complaints_by_reason': (r) => ({ rows: r.complaints }),
  'sup.sla_resolution': (r) => slaInput(r.sla),
});

const PARAMS = Object.freeze({
  'sup.reviews': (p) => ({ minSample: p.minSample }),
  'sup.satisfaction': (p) => ({ minSample: p.minSample }),
  'sup.complaints_by_reason': (p) => ({ maxNoReasonPct: p.maxNoReasonPct }),
});

module.exports = { INPUTS, PARAMS };
