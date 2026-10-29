'use strict';

const { getSetting } = require('../../settings/settings.service');
const { PADROES: PADROES_INBOX } = require('../inbox/inbox.params');
const { readIntakeParams } = require('./intake/intake.params');

/** Padrões do parametros.csv, usados quando a empresa não configurou (e, antes de saber a empresa, como teto da rota pública). */
const PADROES = Object.freeze({ aliasRootEnabled: true, rateLimitPerMinute: 120, channelTokenLength: 32, maxBodyBytes: PADROES_INBOX.maxBodyBytes });

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

/** Parâmetros da empresa dona do canal. */
async function readWebhookParams(tenant, transaction) {
  const [alias, rate, body, intake] = await Promise.all([
    getSetting('integration.webhook.alias_root_enabled', tenant, transaction, PADROES.aliasRootEnabled),
    getSetting('integration.webhook.rate_limit_per_minute', tenant, transaction, PADROES.rateLimitPerMinute),
    getSetting('integration.webhook.max_body_bytes', tenant, transaction, PADROES.maxBodyBytes),
    readIntakeParams(tenant, transaction),
  ]);
  return {
    ...intake,
    aliasRootEnabled: alias !== false && alias !== 'false',
    rateLimitPerMinute: inteiro(rate, PADROES.rateLimitPerMinute, 10),
    maxBodyBytes: Math.min(inteiro(body, PADROES.maxBodyBytes, 1024), platformBodyCeiling()),
  };
}

/** Tamanho do token do canal da empresa (24 a 48). */
async function readChannelTokenLength(tenant, transaction) {
  const n = await getSetting('integration.webhook.channel_token_length', tenant, transaction, PADROES.channelTokenLength);
  return Number.isInteger(n) && n >= 24 && n <= 48 ? n : PADROES.channelTokenLength;
}

/**
 * Teto de tamanho do corpo ANTES de saber a empresa (a leitura do corpo vem antes da connection): a variável de ambiente WEBHOOK_MAX_BODY_BYTES (1024 a 52428800)
 * ou o padrão do parâmetro. O parâmetro da empresa (integration.webhook.max_body_bytes) só aperta esse teto.
 */
function platformBodyCeiling(env = process.env) {
  const n = Number(env.WEBHOOK_MAX_BODY_BYTES);
  return Number.isInteger(n) && n >= 1024 && n <= 52428800 ? n : PADROES.maxBodyBytes;
}

module.exports = { PADROES, readWebhookParams, readChannelTokenLength, platformBodyCeiling };
