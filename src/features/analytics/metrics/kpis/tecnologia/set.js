'use strict';

/** M9-D680 — conjunto de KPIs de Tecnologia (definições, leitura dos read models, entradas e origem) sobre o maquinário comum (kpiSet). */
const { createKpiSet } = require('../legalCor/kpiSet');
const { DEFINITIONS } = require('./definitions');
const { loadTechRows, TECH_READ_MODELS } = require('./rows');
const { INPUTS, PARAMS } = require('./inputs');
const { techFilterOf } = require('./filters');
const { readTechParams } = require('../../../read-models/tecnologia.settings');
const { readTechKpiParams, readTechOwner } = require('../../../read-models/tecnologiaKpi.settings');
const { readFreshnessParams } = require('../../freshness.settings');
require('../../sourceSpecs.tecnologia');

async function readParams(scope, transaction) {
  return { ...(await readTechParams(scope, transaction)), ...(await readTechKpiParams(scope, transaction)), freshness: await readFreshnessParams(scope, transaction) };
}

module.exports = createKpiSet({
  name: 'tech', definitions: DEFINITIONS, readOwner: readTechOwner, readParams, loadRows: (scope, asOfDate, settings, tx) => loadTechRows(scope, asOfDate, settings, tx),
  inputs: INPUTS, params: PARAMS, filterOf: techFilterOf, periodStart: (asOfDate) => asOfDate, watched: TECH_READ_MODELS,
});
