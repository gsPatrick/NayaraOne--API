'use strict';

const { Router } = require('express');
const catchAsync = require('../../../../../utils/catchAsync');
const { success } = require('../../../../../utils/httpResponse');
const { createWebhookRateLimiter } = require('../../../../../middlewares/webhookRateLimit.middleware');
const { unsubscribeByToken } = require('./unsubscribe.service');

async function unsubscribe(req, res) {
  const data = await unsubscribeByToken({ token: req.body && req.body.token });
  return success(res, { data });
}

// Rota PÚBLICA (sem login): o token assinado do link é a autorização e há limite por IP. Aceita o corpo JSON { token } da página de descadastro do site.
const publicRouter = Router();
for (const path of ['/v1/marketing/unsubscribe', '/marketing/unsubscribe']) publicRouter.post(path, createWebhookRateLimiter(), catchAsync(unsubscribe));

module.exports = { publicRouter };
