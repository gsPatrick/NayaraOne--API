'use strict';

// Apoio dos testes dos fatos do dia do Centro de Comando (M9-D710): legal.contracts_signed, crm.opportunities_won e fin.payments_settled_relevant.
const { createKit } = require('./biKpiKit');
const kpisApi = require('../../../src/features/analytics/metrics/kpis');

const MODELS = ['rm_command_events'];
const CODES = ['legal.contracts_signed', 'crm.opportunities_won', 'fin.payments_settled_relevant'];

const kit = createKit({
  models: MODELS, label: 'D710',
  materialize: async (t, asOf, tx) => ({ cmd: await kpisApi.materializeCommandEventKpis({ companyId: t.companyId, groupId: t.groupId }, asOf, tx) }),
});

module.exports = { ...kit, MODELS, CODES };
