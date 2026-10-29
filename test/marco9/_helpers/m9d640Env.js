'use strict';

// Apoio dos testes dos KPIs da carteira de Locação no BI (M9-D640): rent.active_contracts, rent.vacancy e rent.delinquency. Inclui o read model financeiro na limpeza e no
// refresh porque a consistência com fin.overdue_receivables (M9-D622) é critério da demanda.
const { createKit } = require('./biKpiKit');
const kpisApi = require('../../../src/features/analytics/metrics/kpis');

const MODELS = ['rm_rental_contracts', 'rm_rental_vacancy', 'rm_rental_arrears', 'rm_finance_health'];
const CODES = ['rent.active_contracts', 'rent.vacancy', 'rent.delinquency'];

const kit = createKit({
  models: MODELS, label: 'D640',
  materialize: async (t, asOf, tx) => ({ rent: await kpisApi.materializeRentalPortfolioKpis({ companyId: t.companyId, groupId: t.groupId }, asOf, tx) }),
});

module.exports = { ...kit, MODELS, CODES };
