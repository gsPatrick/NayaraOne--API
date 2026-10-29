'use strict';

/**
 * M9-D624 / M9-D609 — provedor do snapshot diário para os KPIs financeiros: calcula, com a linha do rm_finance_health da data-base, o mesmo
 * resultado (valor, dimensões, hash, sourceRefs) que o refresh grava ao vivo. Sem linha do read model na data devolve lista vazia.
 */
const { buildFinanceKpiEntries } = require('./finance.entries');
const { KPI_DEFINITIONS } = require('./finance.definitions');
const { registerSnapshotProvider } = require('../snapshots.providers');

const provider = {
  name: 'finance-kpis',
  metricCodes: KPI_DEFINITIONS.map((d) => d.metricCode),
  async build(scope, asOfDate, transaction) {
    return (await buildFinanceKpiEntries(scope, asOfDate, transaction)).map((e) => ({ code: e.code, inputs: e.inputs }));
  },
};

const register = () => registerSnapshotProvider(provider);

module.exports = { provider, register };
