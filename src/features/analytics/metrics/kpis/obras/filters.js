'use strict';

// M9-D650 / M9-D651 — filtro de origem (sourceRefs) de cada KPI de Obras para a data-base; cada demanda dona declara os dos seus KPIs.
const FILTERS = Object.freeze({
  ...require('./filters.custo').FILTERS, // M9-D650
  ...require('./filters.operacao').FILTERS, // M9-D651
});

/** Filtro canônico da origem do KPI na data-base (sem filtro quando o KPI olha a tabela inteira da empresa). */
const sourceFilter = (code, asOfDate) => FILTERS[code](asOfDate);

module.exports = { sourceFilter };
