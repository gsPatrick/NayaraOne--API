'use strict';

/** M9-D670 / M9-D671 — conjunto de KPIs de Marketing (definições, leitura dos read models, entradas, parâmetros e origem) sobre o maquinário comum (kpiSet). */
const { createKpiSet } = require('../legalCor/kpiSet');
const { DEFINITIONS } = require('./mkt.definitions');
const { loadRows, MKT_READ_MODELS } = require('./mkt.rows');
const { INPUTS, PARAMS } = require('./mkt.inputs');
const { mktFilterOf } = require('./mkt.filters');
const { readMktKpiParams, readMktOwner } = require('../../../read-models/marketingKpi.settings');
require('../../sourceSpecs.marketing');

module.exports = createKpiSet({
  name: 'marketing', definitions: DEFINITIONS, readOwner: readMktOwner, readParams: readMktKpiParams, loadRows, inputs: INPUTS, params: PARAMS,
  filterOf: mktFilterOf, periodStart: (asOfDate) => `${asOfDate.slice(0, 7)}-01`, watched: MKT_READ_MODELS,
});
