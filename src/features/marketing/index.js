'use strict';

const { Router } = require('express');
const { authMiddleware } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const content = require('./content');
const campaigns = require('./campaigns');
const automations = require('./automations');
const publications = require('./publications');
const tracking = require('./tracking');
const suppression = require('./suppression');
const killSwitchRouter = require('./killswitch.service').router;

/**
 * Módulo Marketing (Caderno §Marketing, Guia do Marcelo §2): seis áreas em src/features/marketing/<área>/ (content, campaigns,
 * automations, publications, tracking, suppression), cada uma com service, controller, routes e index. Nenhuma área importa a
 * outra por caminho interno: só pelo index.js. As integrações ficam nos adapters já definidos (M9-D200). Rotas em /marketing/*.
 */
const areas = { content, campaigns, automations, publications, tracking, suppression };

// Rotas públicas (sem login) do Marketing: GET /t/:shortCode (M9-D431) e POST /marketing/webhooks/:channel (M9-D430). Montadas FORA de /marketing, antes das rotas autenticadas.
const publicRouter = Router();
publicRouter.use(tracking.publicRouter);
publicRouter.use(publications.publicRouter);

const router = Router();
router.use('/marketing', authMiddleware, tenantMiddleware);
for (const area of Object.values(areas)) router.use(area.router);
router.use(killSwitchRouter);

module.exports = { router, publicRouter, areas };
