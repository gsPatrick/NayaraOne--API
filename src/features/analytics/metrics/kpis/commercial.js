'use strict';

// M9-D632 / M9-D633 — KPIs de Comercial e Imóveis no BI (visitas, propostas, imóveis, preços, Radar, captação e conversão por corretor): definição no
// registry, cálculo a partir dos read models e gravação do snapshot a cada refresh.
const { DEFINITIONS } = require('./commercial.definitions');
const { ensureCommercialKpisPublished } = require('./commercial.register');
const { materializeCommercialKpis } = require('./commercial.materialize');
const listener = require('./commercial.listener');
const snapshotProvider = require('./commercial.snapshotProvider');

snapshotProvider.register(); // M9-D609: o snapshot diário calcula estes KPIs pelo mesmo caminho do refresh

module.exports = { COMMERCIAL_DEFINITIONS: DEFINITIONS, ensureCommercialKpisPublished, materializeCommercialKpis, installCommercialKpis: listener.install };
