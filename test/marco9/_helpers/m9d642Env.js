'use strict';

// Apoio dos testes dos KPIs de chamados, satisfação e repasses da Locação no BI (M9-D642): rent.tickets, rent.satisfaction e rent.repasses.
const { createKit } = require('./biKpiKit');
const kpisApi = require('../../../src/features/analytics/metrics/kpis');

const MODELS = ['rm_rental_tickets', 'rm_rental_satisfaction', 'rm_rental_repasses'];
const CODES = ['rent.tickets', 'rent.satisfaction', 'rent.repasses'];

const kit = createKit({
  models: MODELS, label: 'D642',
  materialize: async (t, asOf, tx) => ({ rent: await kpisApi.materializeRentalCareKpis({ companyId: t.companyId, groupId: t.groupId }, asOf, tx) }),
});

module.exports = { ...kit, MODELS, CODES };
