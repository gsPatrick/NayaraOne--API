'use strict';

/**
 * M9-D630 / M9-D631 — entrada de cada fórmula dos KPIs do funil comercial a partir das linhas dos read models (crm.rows) e os parâmetros que a fórmula
 * recebe. Mapeamento puro (sem banco): os números chegam como texto inteiro e a fórmula faz a conta em decimal exato.
 */
const sumText = (list, field) => String(list.reduce((acc, r) => acc + BigInt(r[field] || 0), 0n));

const INPUTS = Object.freeze({
  'crm.leads_by_origin': (r) => ({ rows: r.leads.map(({ origin, brokerId, leads }) => ({ origin, brokerId, leads })) }),
  'crm.first_response_time': (r) => ({ rows: r.leads }),
  'crm.opportunities_by_stage': (r) => ({ stages: r.stages, outcome: r.totals }),
  'crm.conversion_rate': (r) => ({ rows: r.totals.map(({ brokerId, won, lost }) => ({ brokerId, won, lost })) }),
  'crm.loss_reasons': (r) => ({ lostTotal: sumText(r.totals, 'lost'), reasons: r.reasons.map(({ lostReason, brokerId, lostCount }) => ({ reason: lostReason, brokerId, count: lostCount })) }),
  'crm.portfolio_without_next_action': (r) => ({ rows: r.next }),
});

const PARAMS = Object.freeze({
  'crm.leads_by_origin': (p) => ({ maxNoOriginPct: p.maxNoOriginPct }),
  'crm.first_response_time': (p) => ({ minSample: p.minSample }),
  'crm.opportunities_by_stage': (p) => ({ stageOrder: p.stageOrder }),
  'crm.conversion_rate': (p) => ({ minSample: p.minSample }),
  'crm.loss_reasons': (p) => ({ maxNoReasonPct: p.maxNoReasonPct }),
  'crm.portfolio_without_next_action': (p) => ({ maxNoBrokerPct: p.maxNoBrokerPct }),
});

/** Em qual conjunto de read models cada KPI mede a atualidade (rows.snapshotAt). */
const SNAPSHOT_KEY = Object.freeze({
  'crm.leads_by_origin': 'lead', 'crm.first_response_time': 'lead', 'crm.opportunities_by_stage': 'stage',
  'crm.conversion_rate': 'outcome', 'crm.loss_reasons': 'outcome', 'crm.portfolio_without_next_action': 'next',
});

module.exports = { INPUTS, PARAMS, SNAPSHOT_KEY };
