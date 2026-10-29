'use strict';

const express = require('express');
const { platformBodyCeiling } = require('./webhooks.params');
const { tooLarge } = require('./webhooks.errors');

/**
 * Corpo bruto da rota pública (M9-D211 passo 1): `req.body` é um Buffer com os bytes EXATOS recebidos, qualquer Content-Type. Acima do limite
 * (teto da plataforma antes de saber a empresa; depois o parâmetro integration.webhook.max_body_bytes dela, que só aperta o teto) responde 413 INTEGRATION_WEBHOOK_TOO_LARGE sem ler o resto.
 * Também guarda o Buffer em `req.rawBody`, onde os serviços antigos o procuram.
 */
const raw = express.raw({ type: () => true, limit: platformBodyCeiling() });

function rawBodyMiddleware(req, res, next) {
  raw(req, res, (err) => {
    if (err) return next(err.type === 'entity.too.large' || err.status === 413 ? tooLarge() : err);
    if (!Buffer.isBuffer(req.body)) req.body = Buffer.alloc(0);
    req.rawBody = req.body;
    return next();
  });
}

module.exports = { rawBodyMiddleware };
