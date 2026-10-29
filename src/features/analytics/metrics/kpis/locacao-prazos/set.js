'use strict';

/** M9-D641 — conjunto de KPIs de prazos da Locação (definições, leitura dos read models, entradas e origem) sobre o maquinário comum (kpiSet). */
const { createKpiSet } = require('../legalCor/kpiSet');
const { DEFINITIONS } = require('./definitions');
const { loadRentalDeadlineRows, RENTAL_DEADLINE_READ_MODELS } = require('./rows');
const { INPUTS, PARAMS } = require('./inputs');
const { rentalFilterOf } = require('./filters');
const { readLocacaoParams } = require('../../../read-models/locacao.settings');
const { readRentalDeadlinesOwner } = require('../../../read-models/locacaoPrazosKpi.settings');
require('../../sourceSpecs.rentalDeadlines');

module.exports = createKpiSet({
  name: 'rental_deadlines', definitions: DEFINITIONS, readOwner: readRentalDeadlinesOwner, readParams: readLocacaoParams, loadRows: loadRentalDeadlineRows, inputs: INPUTS, params: PARAMS,
  filterOf: rentalFilterOf, periodStart: (asOfDate) => asOfDate, watched: RENTAL_DEADLINE_READ_MODELS,
});
