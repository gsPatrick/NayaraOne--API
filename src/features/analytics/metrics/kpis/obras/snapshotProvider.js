'use strict';

/**
 * M9-D650 / M9-D651 / M9-D609 — provedor do snapshot diário para os KPIs de Obras: calcula, com o estado de hoje dos read models de Obras, o mesmo
 * resultado (valor, dimensões, hash, sourceRefs) que o refresh grava ao vivo. Os read models de Obras não guardam histórico por data-base: para uma
 * data que não é hoje (recuperação de dias perdidos) o provedor devolve lista vazia, porque o estado daquela data não existe mais e nada é inventado.
 */
const clock = require('../../clock');
const { registerSnapshotProvider } = require('../../snapshots.providers');
const { buildObraKpiEntries } = require('./entries');
const { KPI_DEFINITIONS } = require('./definitions');

const provider = {
  name: 'obras-kpis',
  metricCodes: KPI_DEFINITIONS.map((d) => d.metricCode),
  async build(scope, asOfDate, transaction) {
    if (asOfDate !== clock.businessToday()) return [];
    return (await buildObraKpiEntries(scope, asOfDate, transaction)).map((e) => ({ code: e.code, inputs: e.inputs }));
  },
};

const register = () => registerSnapshotProvider(provider);

module.exports = { provider, register };
