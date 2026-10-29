'use strict';

// M9-D681 — KPIs de IA no BI: definição no registry, cálculo a partir dos read models de IA e gravação do snapshot a cada refresh.
const ia = require('./set');

ia.registerProvider(); // M9-D609: o snapshot diário calcula estes KPIs pelo mesmo caminho do refresh

module.exports = {
  IA_KPI_DEFINITIONS: ia.definitions,
  ensureIaKpisPublished: ia.ensurePublished,
  materializeIaKpis: ia.materialize,
  buildIaKpiEntries: ia.buildEntries,
  installIaKpis: () => { ia.install(); },
};
