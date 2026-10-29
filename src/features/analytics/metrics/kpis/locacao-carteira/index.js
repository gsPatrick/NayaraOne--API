'use strict';

// M9-D640 — KPIs da carteira de Locação no BI (contratos ativos, vacância e inadimplência): definição no registry, cálculo a partir dos read models e gravação do snapshot a cada refresh.
const rental = require('./set');

rental.registerProvider(); // M9-D609: o snapshot diário calcula estes KPIs pelo mesmo caminho do refresh

module.exports = {
  RENTAL_PORTFOLIO_KPI_DEFINITIONS: rental.definitions,
  ensureRentalPortfolioKpisPublished: rental.ensurePublished,
  materializeRentalPortfolioKpis: rental.materialize,
  buildRentalPortfolioKpiEntries: rental.buildEntries,
  installRentalPortfolioKpis: () => { rental.install(); },
};
