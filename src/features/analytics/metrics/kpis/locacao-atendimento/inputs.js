'use strict';

/** M9-D642 — entrada de cada fórmula dos KPIs de chamados, satisfação e repasses da Locação a partir das linhas dos read models (rows) e os parâmetros que a fórmula recebe. Mapeamento puro (sem banco). */
const INPUTS = Object.freeze({
  'rent.tickets': (r) => ({ row: r.tickets }),
  'rent.satisfaction': (r) => ({ row: r.satisfaction }),
  'rent.repasses': (r) => ({ row: r.repasses }),
});

const PARAMS = Object.freeze({
  'rent.satisfaction': (p) => ({ minSample: p.minSample }),
});

module.exports = { INPUTS, PARAMS };
