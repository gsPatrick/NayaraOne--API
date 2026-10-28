'use strict';

const { mktError } = require('./marketing.errors');
const { EVENT_CATALOG } = require('./marketing.events.catalog');
const { CHECKS } = require('./marketing.events.fields');
const { findForbidden } = require('./marketing.events.forbidden');

function payloadForbidden(details) {
  return mktError(500, 'MKT_EVENT_PAYLOAD_FORBIDDEN', 'Payload de evento contém dado proibido.', details);
}

function payloadInvalid(details) {
  return mktError(500, 'MKT_EVENT_PAYLOAD_INVALID', 'Payload de evento fora do contrato.', details);
}

/** Devolve a entrada do catálogo; nome fora dos 12 do livro é recusado (MKT_EVENT_UNKNOWN). */
function getCatalogEntry(type) {
  const found = typeof type === 'string' && Object.prototype.hasOwnProperty.call(EVENT_CATALOG, type) ? EVENT_CATALOG[type] : null;
  if (!found) throw mktError(500, 'MKT_EVENT_UNKNOWN', 'Evento de Marketing fora do catálogo.', { type: String(type) });
  return found;
}

/**
 * Valida o payload contra o contrato do evento: primeiro dado proibido (privacidade), depois campo fora da lista, obrigatório
 * ausente e tipo errado. attribution.recorded exige exatamente um entre personId e personHash.
 */
function validatePayload(type, payload) {
  const spec = getCatalogEntry(type);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw payloadInvalid({ type });
  const hit = findForbidden(payload);
  if (hit) throw payloadForbidden({ type, path: hit.path, reason: hit.reason });
  for (const key of Object.keys(payload)) {
    if (!(key in spec.fields)) throw payloadForbidden({ type, path: key, reason: 'UNKNOWN_FIELD' });
  }
  for (const key of spec.required) {
    if (!(key in payload) || payload[key] === undefined) throw payloadInvalid({ type, field: key, reason: 'MISSING' });
  }
  for (const [key, value] of Object.entries(payload)) {
    if (!CHECKS[spec.fields[key]](value)) throw payloadInvalid({ type, field: key, reason: 'TYPE' });
  }
  if (type === 'attribution.recorded' && ('personId' in payload) === ('personHash' in payload)) {
    throw payloadInvalid({ type, field: 'personId|personHash', reason: 'EXACTLY_ONE' });
  }
  return spec;
}

module.exports = { validatePayload, getCatalogEntry, payloadForbidden, payloadInvalid };
