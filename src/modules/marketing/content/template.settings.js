'use strict';

const AppError = require('../../../utils/AppError');
const { TEMPLATE_CHANNELS } = require('./template.constants');

/**
 * M9-D404 — Parâmetro dos templates (Marketing). Mesmo padrão do projeto: dicionário fail-closed em SETTINGS_SCHEMA
 * (settings.service.js faz o spread de TEMPLATE_SETTINGS_SCHEMA) + getSetting(chave, tenant, transaction, padrão).
 * Caderno §12: "Templates oficiais quando canal exigir" — quais canais exigem o id aprovado no provedor é do administrador;
 * o padrão do livro é o WhatsApp Business.
 */
const OFFICIAL_CHANNELS_KEY = 'marketing.templates.canais_com_template_oficial';
const TEMPLATE_SETTING_DEFAULTS = Object.freeze({ [OFFICIAL_CHANNELS_KEY]: 'WHATSAPP' });

/** "whatsapp, Email" -> ['WHATSAPP','EMAIL'] (sem vazios nem repetidos). */
function parseChannels(text) {
  if (typeof text !== 'string') return [];
  return [...new Set(text.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean))];
}

function validateChannelList(key, value) {
  const channels = parseChannels(value);
  const unknown = channels.filter((c) => !TEMPLATE_CHANNELS.includes(c));
  if (unknown.length > 0) {
    throw AppError.badRequest(`O valor de "${key}" tem canal(is) desconhecido(s): ${unknown.join(', ')}.`, 'SETTING_INVALID_VALUE', { key, unknown });
  }
  if (channels.length === 0) {
    throw AppError.badRequest(`O valor de "${key}" deve ter ao menos um canal.`, 'SETTING_INVALID_VALUE', { key });
  }
}

const TEMPLATE_SETTINGS_SCHEMA = {
  [OFFICIAL_CHANNELS_KEY]: { type: 'string', validate: validateChannelList },
};

/** Canais cujo template precisa de official_template_ref para ser publicado (configuração da empresa). */
async function readOfficialChannels(tenant, transaction) {
  const { getSetting } = require('../../../features/settings/settings.service');
  const text = await getSetting(OFFICIAL_CHANNELS_KEY, tenant, transaction, TEMPLATE_SETTING_DEFAULTS[OFFICIAL_CHANNELS_KEY]);
  const channels = parseChannels(text);
  return channels.length > 0 ? channels : parseChannels(TEMPLATE_SETTING_DEFAULTS[OFFICIAL_CHANNELS_KEY]);
}

module.exports = {
  OFFICIAL_CHANNELS_KEY, TEMPLATE_SETTING_DEFAULTS, TEMPLATE_SETTINGS_SCHEMA, parseChannels, readOfficialChannels,
};
