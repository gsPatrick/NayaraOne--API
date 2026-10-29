'use strict';

// M9-D680 — KPIs de Tecnologia no BI: definição no registry, cálculo a partir dos read models e gravação do snapshot a cada refresh.
const tech = require('./set');

tech.registerProvider(); // M9-D609: o snapshot diário calcula estes KPIs pelo mesmo caminho do refresh

module.exports = {
  TECH_KPI_DEFINITIONS: tech.definitions,
  ensureTechKpisPublished: tech.ensurePublished,
  materializeTechKpis: tech.materialize,
  buildTechKpiEntries: tech.buildEntries,
  installTechKpis: () => { tech.install(); },
};
