'use strict';

// M9-D641 — KPIs de prazos da Locação no BI: definição no registry, cálculo a partir dos read models e gravação do snapshot a cada refresh.
const rental = require('./set');

rental.registerProvider(); // M9-D609: o snapshot diário calcula estes KPIs pelo mesmo caminho do refresh

module.exports = {
  RENTAL_DEADLINE_KPI_DEFINITIONS: rental.definitions,
  ensureRentalDeadlineKpisPublished: rental.ensurePublished,
  materializeRentalDeadlineKpis: rental.materialize,
  buildRentalDeadlineKpiEntries: rental.buildEntries,
  installRentalDeadlineKpis: () => { rental.install(); },
};
