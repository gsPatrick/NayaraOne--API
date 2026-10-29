'use strict';

/** M9-D661 — conjunto de KPIs do Correspondente (definições, leitura dos read models, entradas, parâmetros e origem) sobre o maquinário comum (kpiSet). */
const { createKpiSet } = require('./kpiSet');
const { DEFINITIONS } = require('./cor.definitions');
const { loadCorRows, COR_READ_MODELS } = require('./cor.rows');
const { INPUTS, PARAMS } = require('./cor.inputs');
const { corFilterOf } = require('./cor.filters');
const { readJurCorKpiParams, readJurCorOwner } = require('../../../read-models/juridicoCorrespondenteKpi.settings');
require('../../sourceSpecs.correspondent');

module.exports = createKpiSet({
  name: 'correspondent', definitions: DEFINITIONS, readOwner: readJurCorOwner, readParams: readJurCorKpiParams, loadRows: loadCorRows, inputs: INPUTS, params: PARAMS,
  filterOf: corFilterOf, periodStart: (asOfDate) => `${asOfDate.slice(0, 7)}-01`, watched: COR_READ_MODELS,
});
