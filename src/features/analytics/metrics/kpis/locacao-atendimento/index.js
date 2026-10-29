'use strict';

// M9-D642 — KPIs de chamados, satisfação e repasses da Locação no BI: definição no registry, cálculo a partir dos read models e gravação do snapshot a cada refresh.
const rentalCare = require('./set');

rentalCare.registerProvider(); // M9-D609: o snapshot diário calcula estes KPIs pelo mesmo caminho do refresh

module.exports = {
  RENTAL_CARE_KPI_DEFINITIONS: rentalCare.definitions,
  ensureRentalCareKpisPublished: rentalCare.ensurePublished,
  materializeRentalCareKpis: rentalCare.materialize,
  buildRentalCareKpiEntries: rentalCare.buildEntries,
  installRentalCareKpis: () => { rentalCare.install(); },
};
