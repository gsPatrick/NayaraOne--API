'use strict';

const { mktError } = require('../../marketing.errors');
const {
  POS_KEYS_DAYS_KEY, RENTAL_DAYS_KEY, NO_REPLY_DAYS_KEY, QUIET_HOURS_KEY, FREQUENCY_CAP_KEY, CADENCE_DEFAULTS, EXPECTED,
} = require('./cadence.defaults');
const { parseDaysList, parseQuietHours, parseFrequencyCap } = require('./cadence.parse');

/**
 * M9-D417 — dicionário fail-closed dos parâmetros de cadência do Marketing (settings.service.js faz o spread). Valor inválido
 * na escrita: 422 MKT_PARAM_INVALID (Valor inválido para o parâmetro.). A leitura é sempre por getMarketingParam.
 */
const PARSERS = Object.freeze({
  [POS_KEYS_DAYS_KEY]: parseDaysList,
  [RENTAL_DAYS_KEY]: parseDaysList,
  [NO_REPLY_DAYS_KEY]: parseDaysList,
  [QUIET_HOURS_KEY]: parseQuietHours,
  [FREQUENCY_CAP_KEY]: parseFrequencyCap,
});

function validateParam(key, value) {
  if (!PARSERS[key](value)) {
    throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, value, esperado: EXPECTED[key] });
  }
}

const CADENCE_SETTINGS_SCHEMA = Object.fromEntries(
  Object.keys(PARSERS).map((key) => [key, { type: 'string', validate: validateParam }])
);

const CADENCE_KEYS = Object.freeze(Object.keys(PARSERS));
/** Qualquer chave destas famílias é gerida aqui: chave desconhecida nelas é 404 MKT_PARAM_NOT_FOUND. */
const CADENCE_FAMILY_PREFIXES = Object.freeze(['marketing.cadencia.', 'marketing.quiet_hours', 'marketing.frequency_cap.']);

function isCadenceFamilyKey(key) {
  return typeof key === 'string' && CADENCE_FAMILY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

module.exports = {
  CADENCE_SETTINGS_SCHEMA, CADENCE_KEYS, CADENCE_DEFAULTS, PARSERS, EXPECTED, isCadenceFamilyKey, validateParam,
};
