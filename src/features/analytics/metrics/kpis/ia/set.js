'use strict';

/** M9-D681 — conjunto de KPIs de IA (definições, leitura dos read models, entradas e origem) sobre o maquinário comum (kpiSet). */
const { createKpiSet } = require('../legalCor/kpiSet');
const { DEFINITIONS } = require('./definitions');
const { loadIaRows, IA_READ_MODELS } = require('./rows');
const { INPUTS, PARAMS } = require('./inputs');
const { iaFilterOf } = require('./filters');
const { readIaKpiParams, readIaOwner } = require('../../../read-models/iaKpi.settings');
require('../../sourceSpecs.ia');

module.exports = createKpiSet({
  name: 'ia', definitions: DEFINITIONS, readOwner: readIaOwner, readParams: readIaKpiParams, loadRows: (scope, asOfDate, settings, tx) => loadIaRows(scope, asOfDate, settings, tx),
  inputs: INPUTS, params: PARAMS, filterOf: iaFilterOf, periodStart: (asOfDate) => `${asOfDate.slice(0, 7)}-01`, watched: IA_READ_MODELS,
});
