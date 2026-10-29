'use strict';

/**
 * M9-D660 — entrada de cada fórmula dos KPIs do Jurídico a partir das linhas dos read models (legal.rows) e os parâmetros que a fórmula recebe.
 * Mapeamento puro (sem banco): os números chegam como texto inteiro e a fórmula faz a conta em decimal exato.
 */
const INPUTS = Object.freeze({
  'legal.deadlines': (r) => {
    const d = r.deadlines || {};
    return { next7: d.due_next_7d, to29: d.due_7_to_29d, overdue: d.overdue, oldestOverdueDays: d.oldest_overdue_days, openTotal: d.open_total, withoutDate: d.without_date };
  },
  'legal.cases_by_risk': (r) => ({ rows: r.risk }),
  'legal.values': (r) => ({ rows: r.values }),
  'legal.missing_documents': (r) => ({ rows: r.docs }),
});

const PARAMS = Object.freeze({
  'legal.cases_by_risk': (p) => ({ maxNoRiskPct: p.maxNoRiskPct }),
  'legal.missing_documents': (p) => ({ maxNoDeadlinePct: p.maxNoDeadlinePct }),
});

module.exports = { INPUTS, PARAMS };
