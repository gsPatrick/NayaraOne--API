'use strict';

/** M9-D642 — conjunto de KPIs de chamados, satisfação e repasses da Locação (definições, leitura dos read models, entradas, parâmetros e origem) sobre o maquinário comum (kpiSet). */
const { createKpiSet } = require('../legalCor/kpiSet');
const { DEFINITIONS } = require('./definitions');
const { loadRentalCareRows, RENTAL_CARE_READ_MODELS } = require('./rows');
const { INPUTS, PARAMS } = require('./inputs');
const { rentalCareFilterOf } = require('./filters');
const { readRentalCareParams, readRentalCareOwner } = require('../../../read-models/locacaoAtendimentoKpi.settings');
require('../../sourceSpecs.rentalCare');

module.exports = createKpiSet({
  name: 'rental_care', definitions: DEFINITIONS, readOwner: readRentalCareOwner, readParams: readRentalCareParams, loadRows: loadRentalCareRows, inputs: INPUTS, params: PARAMS,
  filterOf: rentalCareFilterOf, periodStart: (asOfDate) => `${asOfDate.slice(0, 7)}-01`, watched: RENTAL_CARE_READ_MODELS,
});
