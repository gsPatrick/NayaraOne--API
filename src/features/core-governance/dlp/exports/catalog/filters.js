'use strict';

const { filterInvalid } = require('../export.errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lê só as chaves permitidas de um filtro; chave desconhecida ou valor que não é texto simples é 400 GOV_EXPORT_FILTER_INVALID. */
function pick(filter, allowed, validators = {}) {
  const source = filter === undefined || filter === null ? {} : filter;
  if (typeof source !== 'object' || Array.isArray(source)) throw filterInvalid({ reason: 'O filtro deve ser um objeto.' });
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (!allowed.includes(key)) throw filterInvalid({ field: key });
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || value.length > 100) throw filterInvalid({ field: key });
    if (validators[key] && !validators[key].test(value)) throw filterInvalid({ field: key });
    out[key] = value;
  }
  return out;
}

module.exports = { pick, UUID };
