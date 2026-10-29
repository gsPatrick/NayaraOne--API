'use strict';

// M9-D650 / M9-D651 — KPIs de Obras no BI: definição no registry, cálculo a partir dos read models da M9-D618 e gravação do snapshot a cada refresh.
const { KPI_DEFINITIONS } = require('./definitions');
const { ensureObraKpisPublished } = require('./register');
const { materializeObraKpis } = require('./materialize');
const listener = require('./listener');
const snapshotProvider = require('./snapshotProvider');

module.exports = {
  snapshotProvider,
  install: listener.install,
  api: { OBRA_KPI_DEFINITIONS: KPI_DEFINITIONS, ensureObraKpisPublished, materializeObraKpis, installObraKpis: listener.install },
};
