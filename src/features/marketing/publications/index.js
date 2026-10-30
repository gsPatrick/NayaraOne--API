'use strict';

const { Router } = require('express');
const routes = require('./publications.routes');
const service = require('./publications.service');
const adapters = require('./adapters');
const seo = require('./seo');
const messaging = require('./messaging');
const worker = require('./worker');
const content = require('../content');

// M9-D410: o passo de agendamento do pipeline de conteúdo cria os jobs por esta porta.
content.schedulePort.registerSchedulePort({ scheduleJobs: service.scheduleJobs });

// A área também serve a rota autenticada do sitemap (M9-D427).
const router = Router();
router.use(routes);
router.use(seo.router);

// publicRouter: rotas públicas, montadas fora de /marketing autenticado: webhook dos canais (M9-D430), página pública do imóvel (M9-D427) e descadastro do e-mail (M9-D429).
const publicRouter = Router();
publicRouter.use(adapters.publicRouter);
publicRouter.use(seo.publicRouter);
publicRouter.use(messaging.publicRouter);

module.exports = { router, service, adapters, seo, messaging, worker, publicRouter, installCampaignSendPort: messaging.installCampaignSendPort };
