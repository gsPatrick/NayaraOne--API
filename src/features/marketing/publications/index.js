'use strict';

const { Router } = require('express');
const routes = require('./publications.routes');
const service = require('./publications.service');
const adapters = require('./adapters');
const seo = require('./seo');

// A área também serve a rota autenticada do sitemap (M9-D427).
const router = Router();
router.use(routes);
router.use(seo.router);

// publicRouter: rotas públicas do site e dos canais, montadas fora de /marketing autenticado: webhook dos canais (M9-D430) e página pública do imóvel (M9-D427).
const publicRouter = Router();
publicRouter.use(adapters.publicRouter);
publicRouter.use(seo.publicRouter);

module.exports = { router, service, adapters, seo, publicRouter };
