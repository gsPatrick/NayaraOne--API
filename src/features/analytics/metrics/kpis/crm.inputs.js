'use strict';

/**
 * M9-D630 — entrada de cada fórmula dos KPIs do funil comercial a partir das linhas dos read models (crm.rows) e os parâmetros que a fórmula
 * recebe. Mapeamento puro (sem banco): os números chegam como texto inteiro e a fórmula faz a conta em decimal exato.
 */
const INPUTS = Object.freeze({
  'crm.leads_by_origin': (r) => ({ rows: r.leads.map(({ origin, brokerId, leads }) => ({ origin, brokerId, leads })) }),
  'crm.first_response_time': (r) => ({ rows: r.leads }),
});

const PARAMS = Object.freeze({
  'crm.leads_by_origin': (p) => ({ maxNoOriginPct: p.maxNoOriginPct }),
  'crm.first_response_time': (p) => ({ minSample: p.minSample }),
});

/** Em qual conjunto de read models cada KPI mede a atualidade (rows.snapshotAt). */
const SNAPSHOT_KEY = Object.freeze({ 'crm.leads_by_origin': 'lead', 'crm.first_response_time': 'lead' });

module.exports = { INPUTS, PARAMS, SNAPSHOT_KEY };
