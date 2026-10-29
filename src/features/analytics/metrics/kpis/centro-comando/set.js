'use strict';

/** M9-D710 — conjunto de KPIs de fatos do dia do Centro de Comando (definições, leitura do read model, entradas e origem) sobre o maquinário comum (kpiSet). */
const { createKpiSet } = require('../legalCor/kpiSet');
const clock = require('../../clock');
const { DEFINITIONS } = require('./definitions');
const { loadCommandEventRows, COMMAND_READ_MODELS } = require('./rows');
const { INPUTS, PARAMS } = require('./inputs');
const { commandFilterOf } = require('./filters');
const { readWindowHours, readRelevantAmount, readCommandOwner } = require('../../../read-models/commandEvents.settings');
require('../../sourceSpecs.commandEvents');

/** Um único relógio por cálculo: o mesmo instante define a janela do número e a do filtro de origem. */
async function readParams(scope, transaction) {
  return { now: clock.now(), hours: await readWindowHours(scope, transaction), threshold: await readRelevantAmount(scope, transaction) };
}

module.exports = createKpiSet({
  name: 'command_events', definitions: DEFINITIONS, readOwner: readCommandOwner, readParams, loadRows: loadCommandEventRows, inputs: INPUTS, params: PARAMS,
  filterOf: commandFilterOf, periodStart: (asOfDate) => asOfDate, watched: COMMAND_READ_MODELS,
});
