'use strict';

/** M9-D641 — entrada de cada fórmula dos KPIs de prazos da Locação a partir das linhas dos read models (rows). Mapeamento puro (sem banco): a fórmula faz a conta em decimal exato. */
const INPUTS = Object.freeze({
  'rent.guarantees_expiring': (r) => ({ rows: r.guarantees }),
  'rent.obligations_pending': (r) => ({ rows: r.obligations }),
  'rent.inspections_keys': (r) => ({ row: r.inspections }),
});

module.exports = { INPUTS, PARAMS: Object.freeze({}) };
