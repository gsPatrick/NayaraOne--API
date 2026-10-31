'use strict';

const { Router } = require('express');
const dlpRouter = require('./dlp.routes');
const exportsRouter = require('./exports/exports.routes');
const { publicRouter: sharePublicRouter } = require('./share/share.routes');
const service = require('./dlp.service');

// Rotas do módulo: /dlp (política, links), /exports (M9-D822) e a rota pública /public/share/:token (M9-D823).
const router = Router().use(dlpRouter, exportsRouter, sharePublicRouter);
const anomalyWiring = require('./anomaly.wiring');

// M9-D824: liga a suspensão por anomalia e o destino dos sinais de acesso nos encaixes do guard.
anomalyWiring.install();
// M9-D920: o guard conhece a classe de cada anexo (people.files.classification) em vez de dar a todos a classe padrão.
require('./downloads/download.wiring').install();

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = ["dlp.export.blocked"];

module.exports = { router, service, events };
