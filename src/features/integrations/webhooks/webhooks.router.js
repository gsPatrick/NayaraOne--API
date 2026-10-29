'use strict';

const express = require('express');
const catchAsync = require('../../../utils/catchAsync');
const { rawBodyMiddleware } = require('./webhooks.rawBody');
const { receiveWebhook } = require('./webhooks.handler');

/**
 * Rota pública única de webhooks (M9-D211 3.1): POST /v1/webhooks/:provider/:channel e o alias literal do livro POST /webhooks/:provider/:channel,
 * este ligado pelo parâmetro integration.webhook.alias_root_enabled da empresa dona do canal. Sem JWT, sem cookie, sem CSRF: a autenticidade é a assinatura.
 * Montada no topo das rotas, antes de qualquer gate de autenticação.
 */
const router = express.Router();
const handler = catchAsync(receiveWebhook);
const viaRootAlias = (req, _res, next) => { req.webhookViaRootAlias = true; next(); };

router.post('/v1/webhooks/:provider/:channel', rawBodyMiddleware, handler);
router.post('/webhooks/:provider/:channel', viaRootAlias, rawBodyMiddleware, handler);

module.exports = router;
