'use strict';

/**
 * M9-D632 / M9-D633 / M9-D609 — provedor do snapshot diário para os KPIs de Comercial e Imóveis: calcula, com o estado dos read models, o mesmo resultado
 * (valor, dimensões, hash, sourceRefs) que o refresh grava ao vivo. Data passada: só os KPIs de fluxo; os de posição (imóveis) não são inventados.
 */
const { buildCommercialKpiEntries } = require('./commercial.entries');
const { DEFINITIONS } = require('./commercial.definitions');
const { registerSnapshotProvider } = require('../snapshots.providers');

const provider = {
  name: 'commercial-kpis',
  metricCodes: DEFINITIONS.map((d) => d.metricCode),
  async build(scope, asOfDate, transaction) {
    return (await buildCommercialKpiEntries(scope, asOfDate, transaction)).map((e) => ({ code: e.code, inputs: e.inputs }));
  },
};

const register = () => registerSnapshotProvider(provider);

module.exports = { provider, register };
