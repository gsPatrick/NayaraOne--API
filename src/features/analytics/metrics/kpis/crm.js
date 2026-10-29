'use strict';

// M9-D630 / M9-D631 — KPIs do funil comercial no BI: definição no registry, cálculo a partir dos read models do CRM e gravação do snapshot a cada refresh.
const { DEFINITIONS } = require('./crm.definitions');
const { ensureCrmKpisPublished } = require('./crm.register');
const { materializeCrmKpis } = require('./crm.materialize');
const { buildCrmKpiEntries } = require('./crm.entries');
const listener = require('./crm.listener');
const snapshotProvider = require('./crm.snapshotProvider');

module.exports = {
  snapshotProvider,
  api: { CRM_KPI_DEFINITIONS: DEFINITIONS, ensureCrmKpisPublished, materializeCrmKpis, buildCrmKpiEntries, installCrmKpis: listener.install },
};
