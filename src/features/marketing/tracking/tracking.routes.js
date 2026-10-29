'use strict';

const { Router } = require('express');
const catchAsync = require('../../../utils/catchAsync');
const { createWebhookRateLimiter } = require('../../../middlewares/webhookRateLimit.middleware');
const { buildMarketingRouter } = require('../marketing.module');
const controller = require('./tracking.controller');

// Rota 9 do livro (M9-D435 §3) e rota inferida I5 (criar link, mesma permissão da campanha).
const router = buildMarketingRouter([
  { method: 'get', path: '/marketing/attribution', permission: 'marketing:attribution:read', handler: controller.attribution },
  { method: 'post', path: '/marketing/tracking-links', permission: 'marketing:campaign:manage', handler: controller.createLink },
]);

// Rota inferida I6 (M9-D435): GET /t/:shortCode é PÚBLICA (sem login); a assinatura do link é a autorização e há limite por IP.
const publicRouter = Router();
publicRouter.get('/t/:shortCode', createWebhookRateLimiter(), catchAsync(controller.redirect));

module.exports = { router, publicRouter };
