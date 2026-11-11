'use strict';

const AppError = require('../../utils/AppError');

/**
 * Pentest M5 (achado 2): id que não é uuid (objeto, número, texto) no corpo virava 500 no banco. Os campos de id
 * do Jurídico são conferidos antes de qualquer consulta: ausente passa; presente precisa ser uuid em texto.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidFields(payload, fields) {
  for (const field of fields) {
    const value = payload ? payload[field] : undefined;
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !UUID.test(value)) {
      throw AppError.badRequest(`"${field}" precisa ser um identificador válido (uuid).`, 'LEGAL_INVALID_ID', { field });
    }
  }
}

function assertUuidList(list, field) {
  if (!Array.isArray(list)) return;
  if (list.some((v) => typeof v !== 'string' || !UUID.test(v))) {
    throw AppError.badRequest(`"${field}" precisa ser uma lista de identificadores válidos (uuid).`, 'LEGAL_INVALID_ID', { field });
  }
}

module.exports = { assertUuidFields, assertUuidList, UUID };
