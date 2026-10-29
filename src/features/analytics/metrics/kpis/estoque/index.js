'use strict';

// M9-D653 — KPIs de Estoque e Patrimônio no BI: definição no registry, cálculo a partir dos read models rm_inventory_health e rm_tool_assets e gravação do snapshot a cada refresh.
const { createKpiGroup } = require('../kpiGroup.factory');
const { getReadModel } = require('../../../read-models');
const { KPI_DEFINITIONS, publishInput } = require('./definitions');
const { buildInventoryItems } = require('./sources');
const { MODELS } = require('./models');
require('../../sourceSpecs.estoque');

module.exports = createKpiGroup({
  name: 'estoque', definitions: KPI_DEFINITIONS, publishInput, build: buildInventoryItems, watched: Object.values(MODELS),
  readModelVersion: (name) => getReadModel(name).version,
});
