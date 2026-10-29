'use strict';

const { Router } = require('express');
const dlpRouter = require('./dlp.routes');
const exportsRouter = require('./exports/exports.routes');
const service = require('./dlp.service');

// Rotas do módulo: /dlp (política), /exports (M9-D822).
const router = Router().use(dlpRouter, exportsRouter);
const anomalyWiring = require('./anomaly.wiring');

// M9-D824: liga a suspensão por anomalia e o destino dos sinais de acesso nos encaixes do guard.
anomalyWiring.install();

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = ["dlp.export.blocked"];

module.exports = { router, service, events };
