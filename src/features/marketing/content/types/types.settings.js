'use strict';

const { mktError } = require('../../marketing.errors');
const { parseNameList } = require('../../marketing.settings');

/**
 * M9-D409 — parâmetros dos 10 tipos de conteúdo (aba Marketing de /painel/configuracoes). Mesmo padrão do projeto: dicionário
 * fail-closed em SETTINGS_SCHEMA (settings.service.js faz o spread de TYPES_SETTINGS_SCHEMA) + getSetting(chave, tenant, transaction,
 * padrão). Padrões = valores do livro (hora 08:00, 2 casas do percentual, 1 foto autorizada); o resto é o mais conservador.
 * O fuso do aniversário é o fuso da empresa (parâmetro de horário de silêncio, M9-D417; padrão America/Sao_Paulo).
 */
const BIRTHDAY_TIME_KEY = 'marketing.conteudo.aniversario_hora';
const PERCENT_DECIMALS_KEY = 'marketing.conteudo.reducao_casas_decimais';
const MIN_PHOTOS_KEY = 'marketing.conteudo.minimo_fotos';
const AUTO_DRAFT_TYPES_KEY = 'marketing.conteudo.tipos_rascunho_automatico';
const POST_SALE_PURPOSE_KEY = 'marketing.conteudo.finalidade_pos_venda';
const CONSTRUCTION_SCAN_KEY = 'marketing.conteudo.varredura_obras_min';

const AUTO_DRAFT_CATALOG = Object.freeze([
  'NEW_PROPERTY', 'PRICE_REDUCTION', 'SOLD_RENTED', 'NAYARA_CONSTRUCTION', 'POST_SALE', 'BIRTHDAY_RELATIONSHIP',
]);

const TYPES_SETTING_DEFAULTS = Object.freeze({
  [BIRTHDAY_TIME_KEY]: '08:00',
  [PERCENT_DECIMALS_KEY]: 2,
  [MIN_PHOTOS_KEY]: 1,
  [AUTO_DRAFT_TYPES_KEY]: AUTO_DRAFT_CATALOG.join(', '),
  [POST_SALE_PURPOSE_KEY]: 'POS_VENDA',
  [CONSTRUCTION_SCAN_KEY]: 60,
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PURPOSE_RE = /^[A-Z0-9_]{2,40}$/;

function validateTime(key, value) {
  if (typeof value !== 'string' || !TIME_RE.test(value.trim())) {
    throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado: 'horário HH:MM de 00:00 a 23:59' });
  }
}

function validateTypeList(key, value) {
  const items = parseNameList(value, '');
  if (items.length === 0 || !items.every((item) => AUTO_DRAFT_CATALOG.includes(item))) {
    throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado: `tipos separados por vírgula entre: ${AUTO_DRAFT_CATALOG.join(', ')}` });
  }
}

function validatePurpose(key, value) {
  if (typeof value !== 'string' || !PURPOSE_RE.test(value.trim().toUpperCase())) {
    throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado: 'nome da finalidade (letras, números e _)' });
  }
}

const TYPES_SETTINGS_SCHEMA = {
  [BIRTHDAY_TIME_KEY]: { type: 'string', validate: validateTime },
  [PERCENT_DECIMALS_KEY]: { type: 'integer', min: 0, max: 6 },
  [MIN_PHOTOS_KEY]: { type: 'integer', min: 1, max: 50 },
  [AUTO_DRAFT_TYPES_KEY]: { type: 'string', validate: validateTypeList },
  [POST_SALE_PURPOSE_KEY]: { type: 'string', validate: validatePurpose },
  [CONSTRUCTION_SCAN_KEY]: { type: 'integer', min: 1, max: 1440 },
};

// settings.service.js importa este arquivo (SETTINGS_SCHEMA): a leitura é carregada na hora do uso, para não fechar um ciclo.
const read = (key, tenant, transaction) => require('../../../settings/settings.service').getSetting(key, tenant, transaction, TYPES_SETTING_DEFAULTS[key]);

async function readInteger(key, tenant, transaction) {
  const value = Number(await read(key, tenant, transaction));
  const { min, max } = TYPES_SETTINGS_SCHEMA[key];
  return Number.isInteger(value) && value >= min && value <= max ? value : TYPES_SETTING_DEFAULTS[key];
}

const readPercentDecimals = (tenant, transaction) => readInteger(PERCENT_DECIMALS_KEY, tenant, transaction);
const readMinPhotos = (tenant, transaction) => readInteger(MIN_PHOTOS_KEY, tenant, transaction);
const readConstructionScanMinutes = (tenant, transaction) => readInteger(CONSTRUCTION_SCAN_KEY, tenant, transaction);

/** "HH:MM" da hora diária do aniversário (valor inválido volta ao padrão). */
async function readBirthdayTime(tenant, transaction) {
  const value = String(await read(BIRTHDAY_TIME_KEY, tenant, transaction)).trim();
  return TIME_RE.test(value) ? value : TYPES_SETTING_DEFAULTS[BIRTHDAY_TIME_KEY];
}

async function readAutoDraftTypes(tenant, transaction) {
  const items = parseNameList(await read(AUTO_DRAFT_TYPES_KEY, tenant, transaction), TYPES_SETTING_DEFAULTS[AUTO_DRAFT_TYPES_KEY]);
  return items.filter((item) => AUTO_DRAFT_CATALOG.includes(item));
}

async function readPostSalePurpose(tenant, transaction) {
  const value = String(await read(POST_SALE_PURPOSE_KEY, tenant, transaction)).trim().toUpperCase();
  return PURPOSE_RE.test(value) ? value : TYPES_SETTING_DEFAULTS[POST_SALE_PURPOSE_KEY];
}

module.exports = {
  BIRTHDAY_TIME_KEY, PERCENT_DECIMALS_KEY, MIN_PHOTOS_KEY, AUTO_DRAFT_TYPES_KEY, POST_SALE_PURPOSE_KEY, CONSTRUCTION_SCAN_KEY,
  AUTO_DRAFT_CATALOG, TYPES_SETTING_DEFAULTS, TYPES_SETTINGS_SCHEMA,
  readPercentDecimals, readMinPhotos, readConstructionScanMinutes, readBirthdayTime, readAutoDraftTypes, readPostSalePurpose,
};
