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
  // DI-BI2-9: o instante da leitura (agora, na data-base de hoje) muda a cada passada; no hash entra o efeito dele (itens em aberto e envelhecidos), não o relógio.
  volatileInputs: Object.fromEntries(KPI_DEFINITIONS.map((d) => [d.metricCode, ['asOfInstant']])),
});
