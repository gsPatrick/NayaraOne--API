'use strict';

const router = require('./publications.routes');
const service = require('./publications.service');
const adapters = require('./adapters');

// publicRouter: rota pública de webhook dos canais (M9-D430), montada fora de /marketing autenticado.
module.exports = { router, service, adapters, publicRouter: adapters.publicRouter };
