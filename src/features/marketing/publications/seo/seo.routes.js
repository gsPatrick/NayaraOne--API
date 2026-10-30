'use strict';

const { Router } = require('express');
const catchAsync = require('../../../../utils/catchAsync');
const { createWebhookRateLimiter } = require('../../../../middlewares/webhookRateLimit.middleware');
const { buildMarketingRouter } = require('../../marketing.module');
const controller = require('./seo.controller');

// Rota autenticada: sitemap das páginas ativas.
const router = buildMarketingRouter([
  { method: 'get', path: '/marketing/seo/sitemap', permission: 'marketing:content:read', handler: controller.sitemap },
]);

// Rota PÚBLICA (sem login) do site: o identificador público (uuid imutável) é a chave; há limite por IP. Montada na raiz, antes das rotas autenticadas.
const publicRouter = Router();
for (const path of ['/v1/public/properties/:publicId', '/public/properties/:publicId']) {
  publicRouter.get(path, createWebhookRateLimiter(), catchAsync(controller.getPublicProperty));
}

module.exports = { router, publicRouter };
