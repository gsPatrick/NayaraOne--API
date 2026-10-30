'use strict';

const { CHANNELS, releaseKey } = require('./channels');
const { mktError } = require('../../marketing.errors');
const { registerReleaseGuards } = require('./release/releaseGuard');

/**
 * M9-D430 — parâmetros dos adapters de canal (aba Marketing de Configurações; padrão = parametros.csv).
 * `marketing.channel.<canal>.liberado`: texto `ligado` ou `desligado` (padrão desligado); SÓ o serviço releaseChannel o grava (a trava vive em releaseGuard).
 * `marketing.channel.sandbox.slow_ms`: espera do cenário SLOW do sandbox; `marketing.channel.sandbox.retry_after_s`: Retry-After do cenário HTTP_429.
 */
const SLOW_MS_KEY = 'marketing.channel.sandbox.slow_ms';
const RETRY_AFTER_KEY = 'marketing.channel.sandbox.retry_after_s';
const RELEASED = 'ligado';
const NOT_RELEASED = 'desligado';

const CHANNEL_SETTING_DEFAULTS = Object.freeze({ [SLOW_MS_KEY]: 2000, [RETRY_AFTER_KEY]: 30, ...Object.fromEntries(CHANNELS.map((c) => [releaseKey(c), NOT_RELEASED])) });

function validateRelease(key, value) {
  if (![RELEASED, NOT_RELEASED].includes(value)) throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, value, esperado: `${RELEASED} ou ${NOT_RELEASED}` });
}

const CHANNEL_SETTINGS_SCHEMA = Object.freeze({
  [SLOW_MS_KEY]: { type: 'integer', min: 0, max: 60000 },
  [RETRY_AFTER_KEY]: { type: 'integer', min: 1, max: 3600 },
  ...Object.fromEntries(CHANNELS.map((c) => [releaseKey(c), { type: 'string', validate: validateRelease }])),
});

registerReleaseGuards(CHANNELS.map(releaseKey));

module.exports = { CHANNEL_SETTINGS_SCHEMA, CHANNEL_SETTING_DEFAULTS, SLOW_MS_KEY, RETRY_AFTER_KEY, RELEASED, NOT_RELEASED };
