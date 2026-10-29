'use strict';

// M9-D709 — KPIs da fila de decisão do Centro de Comando: definição no registry, cálculo a partir de rm_decision_queue e gravação do snapshot a cada refresh.
const { createKpiGroup } = require('../kpiGroup.factory');
const { getReadModel } = require('../../../read-models');
const { KPI_DEFINITIONS, publishInput } = require('./definitions');
const { buildDecisionQueueItems } = require('./sources');
const { MODELS } = require('./models');
require('../../sourceSpecs.decisionQueue');

module.exports = createKpiGroup({
  name: 'decisao', definitions: KPI_DEFINITIONS, publishInput, build: buildDecisionQueueItems, watched: Object.values(MODELS),
  readModelVersion: (name) => getReadModel(name).version,
});
