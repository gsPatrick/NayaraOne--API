'use strict';

const { FAMILIES } = require('./evidence.constants');

/**
 * Parâmetros da evidência de campo crítico (aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.dados.campos_criticos (P9-EF-012): lista FAMÍLIA.campo separada por vírgula. Padrão = item 3.1 da M9-D807.
 *  - governanca.dados.evidencia.nota_minima: mínimo de caracteres da nota de OTHER e PERSON_STATEMENT (padrão 10, valor do livro/demanda).
 */
const CRITICAL_FIELDS_KEY = 'governanca.dados.campos_criticos';
const NOTE_MIN_KEY = 'governanca.dados.evidencia.nota_minima';

const DEFAULT_CRITICAL_FIELDS = [
  'PERSON.taxIdNormalized', 'PERSON.legalName', 'PERSON.birthOrFoundationDate',
  'PERSON.bankCode', 'PERSON.agency', 'PERSON.accountNumber', 'PERSON.pixKey', 'PERSON.ownerPersonId',
  'PROPERTY.registryNumber', 'PROPERTY.owner',
  'SUPPLIER.taxIdNormalized', 'SUPPLIER.bankCode', 'SUPPLIER.agency', 'SUPPLIER.accountNumber', 'SUPPLIER.pixKey', 'SUPPLIER.ownerPersonId',
  'REPASSE.bankAccountId',
].join(', ');
const DEFAULT_NOTE_MIN = 10;
const ITEM = /^([A-Z]+)\.([A-Za-z][A-Za-z0-9_]{0,59})$/;

/** "PERSON.pixKey, property.owner" -> ['PERSON.pixKey','PROPERTY.owner'] (família em maiúsculas, campo como escrito; inválidos e repetidos saem). */
function parseCriticalFields(text) {
  const raw = typeof text === 'string' ? text : '';
  const list = raw.split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    const [family, ...rest] = item.split('.');
    return `${family.toUpperCase()}.${rest.join('.')}`;
  }).filter((item) => {
    const match = ITEM.exec(item);
    return match && FAMILIES.includes(match[1]);
  });
  return [...new Set(list)];
}

function validateCriticalFields(key, value) {
  const { govError } = require('../governance.errors');
  const items = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  const bad = items.filter((item) => parseCriticalFields(item).length !== 1);
  if (!items.length || bad.length) {
    throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve listar itens FAMÍLIA.campo separados por vírgula (famílias: ${FAMILIES.join(', ')}).`, { key, invalid: bad });
  }
}

const EVIDENCE_SETTING_DEFAULTS = Object.freeze({ [CRITICAL_FIELDS_KEY]: DEFAULT_CRITICAL_FIELDS, [NOTE_MIN_KEY]: DEFAULT_NOTE_MIN });
const EVIDENCE_SETTINGS_SCHEMA = {
  [CRITICAL_FIELDS_KEY]: { type: 'string', validate: validateCriticalFields },
  [NOTE_MIN_KEY]: { type: 'integer', min: 1, max: 500 },
};

module.exports = { CRITICAL_FIELDS_KEY, NOTE_MIN_KEY, DEFAULT_CRITICAL_FIELDS, DEFAULT_NOTE_MIN, EVIDENCE_SETTING_DEFAULTS, EVIDENCE_SETTINGS_SCHEMA, parseCriticalFields };
