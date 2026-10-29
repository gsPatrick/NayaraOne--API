'use strict';

// M9-D660 / M9-D661 — KPIs do Jurídico e do Correspondente Bancário no BI: definição no registry, cálculo a partir dos read models e gravação do snapshot a cada refresh.
const legal = require('./legal.set');
const correspondent = require('./cor.set');

legal.registerProvider(); // M9-D609: o snapshot diário calcula estes KPIs pelo mesmo caminho do refresh
correspondent.registerProvider();

module.exports = {
  LEGAL_KPI_DEFINITIONS: legal.definitions,
  COR_KPI_DEFINITIONS: correspondent.definitions,
  ensureLegalKpisPublished: legal.ensurePublished,
  ensureCorrespondentKpisPublished: correspondent.ensurePublished,
  materializeLegalKpis: legal.materialize,
  materializeCorrespondentKpis: correspondent.materialize,
  buildLegalKpiEntries: legal.buildEntries,
  buildCorrespondentKpiEntries: correspondent.buildEntries,
  installLegalCorKpis: () => { legal.install(); correspondent.install(); },
};
