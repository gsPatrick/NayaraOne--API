'use strict';

// Apoio dos testes dos KPIs de prazos da Locação no BI (M9-D641): rent.guarantees_expiring, rent.obligations_pending e rent.inspections_keys.
const { createKit } = require('./biKpiKit');
const kpisApi = require('../../../src/features/analytics/metrics/kpis');

const MODELS = ['rm_rental_guarantees', 'rm_rental_obligations', 'rm_rental_inspections_keys'];
const CODES = ['rent.guarantees_expiring', 'rent.obligations_pending', 'rent.inspections_keys'];

const kit = createKit({
  models: MODELS, label: 'D641',
  materialize: async (t, asOf, tx) => ({ rent: await kpisApi.materializeRentalDeadlineKpis({ companyId: t.companyId, groupId: t.groupId }, asOf, tx) }),
});

module.exports = { ...kit, MODELS, CODES };
