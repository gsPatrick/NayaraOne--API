'use strict';

/** M9-D710 — entrada de cada fórmula dos fatos do dia a partir das linhas somadas do read model (mapeamento puro, sem banco): a fórmula faz a conta em decimal exato. */
const INPUTS = Object.freeze({
  'legal.contracts_signed': (r) => ({ rows: r.contracts.rows, previous: r.contracts.previous, undated: r.contracts.undated }),
  'crm.opportunities_won': (r) => ({ rows: r.opportunities.rows, previous: r.opportunities.previous, undated: r.opportunities.undated }),
  'fin.payments_settled_relevant': (r) => ({ rows: r.payments.rows, previous: r.payments.previous, undated: r.payments.undated }),
});

module.exports = { INPUTS, PARAMS: Object.freeze({}) };
