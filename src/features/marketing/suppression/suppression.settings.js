'use strict';

const { mktError } = require('../marketing.errors');
const { parseNameList } = require('../marketing.settings');

/**
 * M9-D418 — parâmetros da supressão, do consentimento e da política de canal do canSend. Mesmo padrão do projeto: dicionário
 * fail-closed em SETTINGS_SCHEMA (settings.service.js faz o spread de SUPPRESSION_SETTINGS_SCHEMA) + getSetting. Os padrões são os
 * de Maturacao/demandas/parametros.csv. A lista única de finalidades é a união das duas listas de consentimento.
 */
const OPT_IN_PURPOSES_KEY = 'marketing.consent.exige_opt_in_para';
const NO_OPT_IN_PURPOSES_KEY = 'marketing.consent.sem_opt_in_para';
const OPT_OUT_WORDS_KEY = 'marketing.suppression.palavras_opt_out';
const SERVICE_WINDOW_KEY = 'marketing.whatsapp.janela_atendimento_h';
const COUNTRY_CODE_KEY = 'marketing.suppression.codigo_pais_padrao';
const OFFICIAL_CHANNELS_KEY = 'marketing.templates.canais_com_template_oficial';

// settings.service.js importa este arquivo (SETTINGS_SCHEMA): a leitura é carregada na hora do uso, para não fechar um ciclo.
const getSetting = (...args) => require('../../settings/settings.service').getSetting(...args);

const SUPPRESSION_DEFAULTS = Object.freeze({
  [OPT_IN_PURPOSES_KEY]: 'MARKETING, NUTRICAO, RADAR, AVALIACAO, POS_VENDA',
  [NO_OPT_IN_PURPOSES_KEY]: 'TRANSACTIONAL, ACOMPANHAMENTO',
  [OPT_OUT_WORDS_KEY]: 'SAIR, PARAR, STOP, CANCELAR',
  [SERVICE_WINDOW_KEY]: 24,
  [COUNTRY_CODE_KEY]: '55',
});

const TOKEN_RE = /^[A-Z0-9_]{2,40}$/;
const SERVICE_WINDOW_LIMITS = Object.freeze({ min: 1, max: 168 });

function validateTokenList(key, value) {
  const items = parseNameList(value, '');
  if (items.length === 0 || !items.every((item) => TOKEN_RE.test(item))) {
    throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado: 'nomes separados por vírgula (letras, números e _), ex.: MARKETING, NUTRICAO' });
  }
}

const SUPPRESSION_SETTINGS_SCHEMA = {
  [OPT_IN_PURPOSES_KEY]: { type: 'string', validate: validateTokenList },
  [NO_OPT_IN_PURPOSES_KEY]: { type: 'string', validate: validateTokenList },
  [OPT_OUT_WORDS_KEY]: { type: 'string', validate: validateTokenList },
  [SERVICE_WINDOW_KEY]: { type: 'integer', min: SERVICE_WINDOW_LIMITS.min, max: SERVICE_WINDOW_LIMITS.max },
  [COUNTRY_CODE_KEY]: {
    type: 'string',
    validate: (key, value) => {
      if (!/^[1-9]\d{0,2}$/.test(String(value).trim())) {
        throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado: 'código do país com 1 a 3 dígitos, ex.: 55' });
      }
    },
  },
};

async function readList(key, tenant, transaction) {
  return parseNameList(await getSetting(key, tenant, transaction, SUPPRESSION_DEFAULTS[key]), SUPPRESSION_DEFAULTS[key]);
}

/** Lista única de finalidades: quais exigem OPT_IN e quais não exigem (o resto é recusado). */
async function readPurposeLists(tenant, transaction) {
  const [requireOptIn, noOptIn] = await Promise.all([
    readList(OPT_IN_PURPOSES_KEY, tenant, transaction),
    readList(NO_OPT_IN_PURPOSES_KEY, tenant, transaction),
  ]);
  return { requireOptIn, noOptIn: noOptIn.filter((p) => !requireOptIn.includes(p)) };
}

const readOptOutWords = (tenant, transaction) => readList(OPT_OUT_WORDS_KEY, tenant, transaction);

async function readServiceWindowHours(tenant, transaction) {
  const raw = Number(await getSetting(SERVICE_WINDOW_KEY, tenant, transaction, SUPPRESSION_DEFAULTS[SERVICE_WINDOW_KEY]));
  return Number.isInteger(raw) && raw >= SERVICE_WINDOW_LIMITS.min ? raw : SUPPRESSION_DEFAULTS[SERVICE_WINDOW_KEY];
}

async function readDefaultCountryCode(tenant, transaction) {
  const raw = String(await getSetting(COUNTRY_CODE_KEY, tenant, transaction, SUPPRESSION_DEFAULTS[COUNTRY_CODE_KEY])).trim();
  return /^[1-9]\d{0,2}$/.test(raw) ? raw : SUPPRESSION_DEFAULTS[COUNTRY_CODE_KEY];
}

async function readOfficialTemplateChannels(tenant, transaction) {
  return parseNameList(await getSetting(OFFICIAL_CHANNELS_KEY, tenant, transaction, 'WHATSAPP'), 'WHATSAPP');
}

module.exports = {
  OPT_IN_PURPOSES_KEY, NO_OPT_IN_PURPOSES_KEY, OPT_OUT_WORDS_KEY, SERVICE_WINDOW_KEY, COUNTRY_CODE_KEY, SUPPRESSION_DEFAULTS, SUPPRESSION_SETTINGS_SCHEMA,
  readPurposeLists, readOptOutWords, readServiceWindowHours, readDefaultCountryCode, readOfficialTemplateChannels,
};
