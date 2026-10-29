'use strict';

const AppError = require('../../../utils/AppError');

/**
 * M9-D419 — lista fechada de campos que NUNCA servem de critério de segmentação (dado sensível). Mesmo padrão do projeto: dicionário
 * fail-closed em SETTINGS_SCHEMA (settings.service.js faz o spread de SEGMENT_SETTINGS_SCHEMA) + getSetting(chave, tenant, transaction,
 * padrão). Padrão = lista do livro (Maturacao/demandas/parametros.csv, MKT-P062). Nomes em minúsculas com `_`.
 */
const FORBIDDEN_KEY = 'marketing.segment.campos_proibidos';
const DEFAULT_FORBIDDEN = Object.freeze([
  'renda_exata', 'renda', 'saude', 'deficiencia', 'cpf', 'cnpj', 'rg', 'documento', 'restricao_credito', 'divida', 'score_credito',
  'orientacao_sexual', 'religiao', 'etnia',
]);
const SEGMENT_SETTING_DEFAULTS = Object.freeze({ [FORBIDDEN_KEY]: DEFAULT_FORBIDDEN.join(', ') });
const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;

const parseList = (text) => String(text === undefined || text === null ? '' : text).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);

function validateList(key, value) {
  const items = parseList(value);
  if (items.length === 0 || !items.every((item) => NAME_RE.test(item))) {
    throw AppError.badRequest(`O valor de "${key}" deve ser nomes de campo separados por vírgula (minúsculas, números e _), ex.: renda_exata, cpf.`, 'SETTING_INVALID_VALUE', { key });
  }
}

const SEGMENT_SETTINGS_SCHEMA = { [FORBIDDEN_KEY]: { type: 'string', validate: validateList } };

/** Campos proibidos da empresa (valor inválido guardado volta ao padrão). */
async function readForbiddenSegmentFields(tenant, transaction) {
  const { getSetting } = require('../../../features/settings/settings.service');
  const items = parseList(await getSetting(FORBIDDEN_KEY, tenant, transaction, SEGMENT_SETTING_DEFAULTS[FORBIDDEN_KEY]));
  return items.length > 0 && items.every((item) => NAME_RE.test(item)) ? items : [...DEFAULT_FORBIDDEN];
}

module.exports = { FORBIDDEN_KEY, DEFAULT_FORBIDDEN, SEGMENT_SETTING_DEFAULTS, SEGMENT_SETTINGS_SCHEMA, readForbiddenSegmentFields };
