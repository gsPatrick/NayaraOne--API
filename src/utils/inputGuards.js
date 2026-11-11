'use strict';

const AppError = require('./AppError');

/**
 * Fechamento M5 (pentest automatizado da Locação): entrada que não é do tipo esperado vira 400 com código claro na
 * própria rota, nunca 500 do banco. `assertUuid` recusa objeto/lista/texto no lugar de identificador (ex.:
 * {"$gt":""}); `assertText` recusa não-texto e texto acima do tamanho da coluna.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isBlank = (v) => v === undefined || v === null || v === '';

function assertUuid(value, field, code, { optional = false } = {}) {
  if (isBlank(value)) {
    if (optional) return null;
    throw AppError.badRequest(`O campo "${field}" é obrigatório.`, code);
  }
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw AppError.badRequest(`O campo "${field}" deve ser um identificador válido.`, code);
  }
  return value;
}

function assertText(value, field, max, code, { optional = true } = {}) {
  if (isBlank(value)) {
    if (optional) return null;
    throw AppError.badRequest(`O campo "${field}" é obrigatório.`, code);
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw AppError.badRequest(`O campo "${field}" deve ser um texto.`, code);
  }
  const text = String(value);
  if (text.length > max) throw AppError.badRequest(`O campo "${field}" aceita no máximo ${max} caracteres.`, code);
  return text;
}

function assertPeriod(value, field, code) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw AppError.badRequest(`O campo "${field}" deve estar no formato "AAAA-MM".`, code);
  }
  return value;
}

module.exports = { assertUuid, assertText, assertPeriod, UUID_RE };
