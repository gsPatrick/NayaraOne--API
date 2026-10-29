'use strict';

/** M9-D660 — conjunto de KPIs do Jurídico (definições, leitura dos read models, entradas, parâmetros e origem) sobre o maquinário comum (kpiSet). */
const { createKpiSet } = require('./kpiSet');
const { DEFINITIONS } = require('./legal.definitions');
const { loadLegalRows, LEGAL_READ_MODELS } = require('./legal.rows');
const { INPUTS, PARAMS } = require('./legal.inputs');
const { legalFilterOf } = require('./legal.filters');
const { readJurCorKpiParams, readJurCorOwner } = require('../../../read-models/juridicoCorrespondenteKpi.settings');
const { readFinishedStatuses } = require('../../../read-models/juridico.settings');
require('../../sourceSpecs.legal');

async function readParams(scope, transaction) {
  return { ...(await readJurCorKpiParams(scope, transaction)), finishedStatuses: await readFinishedStatuses(scope, transaction) };
}

module.exports = createKpiSet({
  name: 'legal', definitions: DEFINITIONS, readOwner: readJurCorOwner, readParams, loadRows: loadLegalRows, inputs: INPUTS, params: PARAMS,
  filterOf: legalFilterOf, periodStart: (asOfDate) => asOfDate, watched: LEGAL_READ_MODELS,
});
