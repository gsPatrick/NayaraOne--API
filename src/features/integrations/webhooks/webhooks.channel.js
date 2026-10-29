'use strict';

const crypto = require('crypto');
const { readChannelTokenLength } = require('./webhooks.params');

/** Token opaco do canal do webhook (M9-D211 3.1): 24 a 48 caracteres [A-Za-z0-9_-], aleatório (CSPRNG), tamanho pelo parâmetro integration.webhook.channel_token_length. */
async function generateChannelToken(ctx, transaction) {
  const tamanho = await readChannelTokenLength(ctx, transaction);
  return crypto.randomBytes(Math.ceil((tamanho * 3) / 4)).toString('base64url').slice(0, tamanho);
}

module.exports = { generateChannelToken };
