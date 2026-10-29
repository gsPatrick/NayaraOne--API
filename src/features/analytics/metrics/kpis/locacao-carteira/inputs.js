'use strict';

/** M9-D640 — entrada de cada fórmula dos KPIs da carteira de Locação a partir das linhas dos read models (rows). Mapeamento puro (sem banco): a fórmula faz a conta em decimal exato. */
const INPUTS = Object.freeze({
  'rent.active_contracts': (r) => ({ rows: r.contracts }),
  'rent.vacancy': (r) => ({ row: r.vacancy }),
  'rent.delinquency': (r, { settings }) => ({ row: r.arrears, windowDays: settings.windowDays }),
});

const PARAMS = Object.freeze({
  'rent.active_contracts': (s) => ({ rentBands: s.rentBands }),
  'rent.delinquency': (s) => ({ bands: s.overdueBands }),
});

module.exports = { INPUTS, PARAMS };
