'use strict';

// M9-D670 / M9-D671 — KPIs de Marketing no BI: definição no registry, cálculo a partir dos read models e gravação do snapshot a cada refresh.
const marketing = require('./mkt.set');

marketing.registerProvider(); // M9-D609: o snapshot diário calcula estes KPIs pelo mesmo caminho do refresh

module.exports = {
  MKT_KPI_DEFINITIONS: marketing.definitions,
  ensureMarketingKpisPublished: marketing.ensurePublished,
  materializeMarketingKpis: marketing.materialize,
  buildMarketingKpiEntries: marketing.buildEntries,
  installMarketingKpis: () => { marketing.install(); },
};
