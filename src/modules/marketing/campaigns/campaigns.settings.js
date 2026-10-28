'use strict';

/**
 * M9-D412 — parâmetro das campanhas (aba Marketing de /painel/configuracoes). Dicionário fail-closed em SETTINGS_SCHEMA
 * (settings.service.js faz o spread de CAMPAIGN_SETTINGS_SCHEMA) + getSetting(chave, tenant, transaction, padrão).
 * O livro não diz quantos destinatários o job processa por ciclo; o padrão é 200 e o administrador ajusta.
 */
const RECIPIENT_BATCH_KEY = 'marketing.campanhas.lote_destinatarios';
const CAMPAIGN_SETTING_DEFAULTS = Object.freeze({ [RECIPIENT_BATCH_KEY]: 200 });
const CAMPAIGN_SETTINGS_SCHEMA = { [RECIPIENT_BATCH_KEY]: { type: 'integer', min: 1, max: 10000 } };

/** Destinatários processados por step a cada rodada do job (o restante fica para a rodada seguinte). */
async function readRecipientBatch(tenant, transaction) {
  const { getSetting } = require('../../../features/settings/settings.service');
  const value = Number(await getSetting(RECIPIENT_BATCH_KEY, tenant, transaction, CAMPAIGN_SETTING_DEFAULTS[RECIPIENT_BATCH_KEY]));
  return Number.isInteger(value) && value >= 1 ? value : CAMPAIGN_SETTING_DEFAULTS[RECIPIENT_BATCH_KEY];
}

module.exports = { RECIPIENT_BATCH_KEY, CAMPAIGN_SETTING_DEFAULTS, CAMPAIGN_SETTINGS_SCHEMA, readRecipientBatch };
