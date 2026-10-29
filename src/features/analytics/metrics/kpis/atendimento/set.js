'use strict';

/** M9-D672 — conjunto de KPIs de Atendimento (definições, leitura dos read models, entradas, parâmetros e origem) sobre o maquinário comum (kpiSet). */
const { createKpiSet } = require('../legalCor/kpiSet');
const { DEFINITIONS } = require('./definitions');
const { loadSupportRows, SUPPORT_READ_MODELS } = require('./rows');
const { INPUTS, PARAMS } = require('./inputs');
const { supportFilterOf } = require('./filters');
const { readSupportKpiParams, readSupportOwner } = require('../../../read-models/atendimentoKpi.settings');
require('../../sourceSpecs.support');

module.exports = createKpiSet({
  name: 'support', definitions: DEFINITIONS, readOwner: readSupportOwner, readParams: readSupportKpiParams, loadRows: loadSupportRows, inputs: INPUTS, params: PARAMS,
  filterOf: supportFilterOf, periodStart: (asOfDate) => `${asOfDate.slice(0, 7)}-01`, watched: SUPPORT_READ_MODELS,
});
