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

// M9-D414: o runner de automações chama outras áreas por portas (sem import entre áreas): canSend, envio de mensagem e rascunho de conteúdo.
automations.runner.registerRunnerPorts({ canSend: suppression.canSend, sendMessage: publications.messaging.sendMarketingMessage, createDraft: content.service.createContent });

/**
 * Módulo Marketing (Caderno §Marketing, Guia do Marcelo §2): seis áreas em src/features/marketing/<área>/ (content, campaigns,
 * automations, publications, tracking, suppression), cada uma com service, controller, routes e index. Nenhuma área importa a
 * outra por caminho interno: só pelo index.js. As integrações ficam nos adapters já definidos (M9-D200). Rotas em /marketing/*.
 */
automations.reviews.registerTrackingLinkPort(tracking.service.createTrackingLink); // M9-D424: o link da avaliação é rastreável (M9-D431)
publications.messaging.registerDeliveryListener(automations.reviews.onDeliveryStatus); // M9-D424: o pedido acompanha a entrega da mensagem
automations.seeds.registerUrlGuard(tracking.urls.assertAllowedUrl); // a regra única de URL externa (M9-D433) para o link de pesquisa e de avaliação

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
