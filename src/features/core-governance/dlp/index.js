'use strict';

const router = require('./dlp.routes');
const service = require('./dlp.service');
const anomalyWiring = require('./anomaly.wiring');

// M9-D824: liga a suspensão por anomalia e o destino dos sinais de acesso nos encaixes do guard.
anomalyWiring.install();

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = ["dlp.export.blocked"];

module.exports = { router, service, events };
