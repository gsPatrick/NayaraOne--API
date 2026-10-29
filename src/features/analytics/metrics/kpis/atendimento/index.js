'use strict';

// M9-D672 — KPIs de Atendimento no BI: definição no registry, cálculo a partir dos read models e gravação do snapshot a cada refresh.
const support = require('./set');

support.registerProvider(); // M9-D609: o snapshot diário calcula estes KPIs pelo mesmo caminho do refresh

module.exports = {
  SUPPORT_KPI_DEFINITIONS: support.definitions,
  ensureSupportKpisPublished: support.ensurePublished,
  materializeSupportKpis: support.materialize,
  buildSupportKpiEntries: support.buildEntries,
  installSupportKpis: () => { support.install(); },
};
