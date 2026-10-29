'use strict';

// Apoio dos testes dos KPIs de Atendimento no BI (M9-D672): sup.reviews, sup.satisfaction, sup.complaints_by_reason e sup.sla_resolution.
const { createKit } = require('./biKpiKit');
const kpisApi = require('../../../src/features/analytics/metrics/kpis');

const MODELS = ['rm_mkt_reviews', 'rm_support_satisfaction', 'rm_support_complaints', 'rm_support_sla'];
const CODES = ['sup.reviews', 'sup.satisfaction', 'sup.complaints_by_reason', 'sup.sla_resolution'];

const kit = createKit({
  models: MODELS, label: 'D672',
  materialize: async (t, asOf, tx) => ({ sup: await kpisApi.materializeSupportKpis({ companyId: t.companyId, groupId: t.groupId }, asOf, tx) }),
});

module.exports = { ...kit, MODELS, CODES };
