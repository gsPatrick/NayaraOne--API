'use strict';

/**
 * M9-D414 — parâmetros do runner (aba Marketing): tempo máximo de cada ação (padrão 30 s, o mesmo do worker de publicação) e a ordem dos canais quando a ação de
 * envio pede `channel: "AUTO"` (primeiro canal em que a pessoa tem endereço; nenhum = NO_CONTACT_CHANNEL). O vencimento das ações adiadas (60 s) é constante do job.
 */
const ACTION_TIMEOUT_KEY = 'marketing.runner.acao_timeout_s';
const AUTO_CHANNELS_KEY = 'marketing.runner.canais_automaticos';
const RUNNER_SETTING_DEFAULTS = Object.freeze({ [ACTION_TIMEOUT_KEY]: 30, [AUTO_CHANNELS_KEY]: 'WHATSAPP, EMAIL' });
const AUTO_CHANNELS = ['WHATSAPP', 'EMAIL'];
const RUNNER_SETTINGS_SCHEMA = {
  [ACTION_TIMEOUT_KEY]: { type: 'integer', min: 1, max: 3600 },
  [AUTO_CHANNELS_KEY]: {
    type: 'string',
    validate: (key, value) => {
      const list = String(value).split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
      if (list.length === 0 || !list.every((c) => AUTO_CHANNELS.includes(c))) {
        const { mktError } = require('../../marketing.errors');
        throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado: `Canais separados por vírgula entre: ${AUTO_CHANNELS.join(', ')}` });
      }
    },
  },
};

async function readRunnerParams(tenant, transaction) {
  const { getSetting } = require('../../../settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este arquivo
  const timeout = Number(await getSetting(ACTION_TIMEOUT_KEY, tenant, transaction, RUNNER_SETTING_DEFAULTS[ACTION_TIMEOUT_KEY]));
  const channels = String(await getSetting(AUTO_CHANNELS_KEY, tenant, transaction, RUNNER_SETTING_DEFAULTS[AUTO_CHANNELS_KEY]))
    .split(',').map((c) => c.trim().toUpperCase()).filter((c) => AUTO_CHANNELS.includes(c));
  return {
    actionTimeoutS: Number.isInteger(timeout) && timeout >= 1 ? timeout : RUNNER_SETTING_DEFAULTS[ACTION_TIMEOUT_KEY],
    autoChannels: channels.length ? channels : AUTO_CHANNELS,
  };
}

module.exports = { ACTION_TIMEOUT_KEY, AUTO_CHANNELS_KEY, RUNNER_SETTING_DEFAULTS, RUNNER_SETTINGS_SCHEMA, readRunnerParams };
