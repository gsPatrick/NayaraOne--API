'use strict';

const { Router } = require('express');
const catchAsync = require('../../../../../utils/catchAsync');
const { createWebhookRateLimiter } = require('../../../../../middlewares/webhookRateLimit.middleware');
const { rawBodyMiddleware } = require('../../../../integrations/webhooks/webhooks.rawBody');
const controller = require('./webhook.controller');

/**
 * Rota PÚBLICA (sem login): a assinatura do canal é a autorização, e há limite por IP. Corpo BRUTO (webhooks.paths.js tira a rota do parser de JSON; o limite
 * de tamanho é o do framework). Montada na raiz, antes das rotas autenticadas (marketing/index.js): `/v1/marketing/webhooks/:channel` e o literal do livro.
 */
const publicRouter = Router();
for (const path of ['/v1/marketing/webhooks/:channel', '/marketing/webhooks/:channel']) {
  publicRouter.post(path, createWebhookRateLimiter(), rawBodyMiddleware, catchAsync(controller.receive));
}

module.exports = { publicRouter };
