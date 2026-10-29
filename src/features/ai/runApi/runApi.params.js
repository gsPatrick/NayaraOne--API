'use strict';

const { getSetting } = require('../../settings/settings.service');
const { RUN_API_SETTING_DEFAULTS } = require('./runApi.settings');

const KEYS = Object.freeze({
  syncMaxMs: 'ia.run.sincrono_max_ms',
  chatMaxMessages: 'ia.chat.max_mensagens',
  conversationValidityHours: 'ia.chat.conversa_validade_horas',
});

async function readInt(key, tenant, transaction, min) {
  const value = await getSetting(key, tenant, transaction, RUN_API_SETTING_DEFAULTS[key]);
  return Number.isInteger(value) && value >= min ? value : RUN_API_SETTING_DEFAULTS[key];
}

/** Lê, a cada pedido, os três parâmetros das rotas de execução (valor inválido volta ao padrão do livro). */
async function readRunApiParams(tenant, transaction) {
  return {
    syncMaxMs: await readInt(KEYS.syncMaxMs, tenant, transaction, 1),
    chatMaxMessages: await readInt(KEYS.chatMaxMessages, tenant, transaction, 0),
    conversationValidityHours: await readInt(KEYS.conversationValidityHours, tenant, transaction, 1),
  };
}

module.exports = { readRunApiParams, KEYS };
