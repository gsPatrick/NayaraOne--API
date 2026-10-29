'use strict';

// M9-D652 — KPIs de desperdício, custo pós-obra e recorrência no BI: definição no registry, cálculo a partir dos read models de Obras e gravação do snapshot a cada refresh.
const { createKpiGroup } = require('../kpiGroup.factory');
const { getReadModel } = require('../../../read-models');
const { KPI_DEFINITIONS, publishInput } = require('./definitions');
const { buildObraCostItems } = require('./sources');
const { MODELS } = require('./models');
require('../../sourceSpecs.obraCustos');

module.exports = createKpiGroup({
  name: 'obra_perdas', definitions: KPI_DEFINITIONS, publishInput, build: buildObraCostItems, watched: Object.values(MODELS),
  readModelVersion: (name) => getReadModel(name).version,
});
