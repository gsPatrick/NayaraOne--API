'use strict';

// M9-D660 — KPIs do Jurídico no BI: definição no registry, cálculo a partir dos read models e gravação do snapshot a cada refresh.
const legal = require('./legal.set');

legal.registerProvider(); // M9-D609: o snapshot diário calcula estes KPIs pelo mesmo caminho do refresh

module.exports = {
  LEGAL_KPI_DEFINITIONS: legal.definitions,
  ensureLegalKpisPublished: legal.ensurePublished,
  materializeLegalKpis: legal.materialize,
  buildLegalKpiEntries: legal.buildEntries,
  installLegalCorKpis: () => { legal.install(); },
};
