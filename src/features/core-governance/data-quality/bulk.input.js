'use strict';

const crypto = require('node:crypto');
const { FIELDS } = require('./bulk.fields');
const errors = require('./bulk.errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_IN_ITEMS = 500;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const pick = (body, snake, camel) => (body[snake] !== undefined ? body[snake] : body[camel]);

/** JSON com as chaves em ordem: o mesmo conteúdo dá o mesmo hash, qualquer que seja a ordem das chaves no corpo. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}
const sha256 = (value) => crypto.createHash('sha256').update(canonical(value)).digest('hex');

function scalarOf(spec, value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > spec.max) throw errors.filterInvalid({ field: name });
  return value;
}

/** Filtro estruturado (nunca SQL): `ids` e campos da lista fechada; valor = texto, lista de textos ou { isNull: true|false }. */
function parseFilter(entityType, raw) {
  if (!isPlainObject(raw) || !Object.keys(raw).length) throw errors.filterInvalid({ reason: 'o filtro precisa ser um objeto com ao menos um critério' });
  const allowed = FIELDS[entityType].filter;
  const out = { ids: null, fields: {} };
  for (const [name, value] of Object.entries(raw)) {
    if (name === 'ids') {
      if (!Array.isArray(value) || !value.length || value.some((id) => typeof id !== 'string' || !UUID.test(id))) throw errors.filterInvalid({ field: 'ids' });
      out.ids = [...new Set(value.map((id) => id.toLowerCase()))];
    } else if (Object.prototype.hasOwnProperty.call(allowed, name)) {
      const spec = allowed[name];
      if (isPlainObject(value)) {
        if (Object.keys(value).length !== 1 || typeof value.isNull !== 'boolean') throw errors.filterInvalid({ field: name });
        out.fields[name] = { op: 'null', value: value.isNull };
      } else if (Array.isArray(value)) {
        if (!value.length || value.length > MAX_IN_ITEMS) throw errors.filterInvalid({ field: name });
        out.fields[name] = { op: 'in', value: value.map((item) => scalarOf(spec, item, name)) };
      } else out.fields[name] = { op: 'eq', value: scalarOf(spec, value, name) };
    } else throw errors.filterInvalid({ field: name });
  }
  return out;
}

function parseValue(name, spec, value) {
  if (value === null) {
    if (!spec.nullable) throw errors.validation(`O campo "${name}" não pode ficar vazio.`, { field: name });
    return null;
  }
  if (spec.kind === 'text') {
    if (typeof value !== 'string' || value.length > spec.max) throw errors.validation(`O campo "${name}" deve ser um texto de até ${spec.max} caracteres.`, { field: name });
    const trimmed = value.trim();
    if (!trimmed) {
      if (!spec.nullable) throw errors.validation(`O campo "${name}" não pode ficar vazio.`, { field: name });
      return null;
    }
    return trimmed;
  }
  if (spec.kind === 'date') {
    if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw errors.validation(`O campo "${name}" deve ser uma data AAAA-MM-DD.`, { field: name });
    return value;
  }
  if (spec.kind === 'enum') {
    if (typeof value !== 'string' || !spec.values.includes(value.toUpperCase())) throw errors.validation(`O campo "${name}" deve ser um de: ${spec.values.join(', ')}.`, { field: name });
    return value.toUpperCase();
  }
  if (typeof value !== 'string' || !UUID.test(value)) throw errors.validation(`O campo "${name}" deve ser o identificador de um usuário.`, { field: name });
  return value.toLowerCase();
}

function parsePatch(entityType, raw) {
  if (!isPlainObject(raw) || !Object.keys(raw).length) throw errors.validation('Informe ao menos um campo a alterar.', { field: 'patch' });
  const allowed = FIELDS[entityType].patch;
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(allowed, name)) throw errors.validation(`O campo "${name}" não pode ser alterado em massa.`, { field: name, allowed: Object.keys(allowed) });
    out[name] = parseValue(name, allowed[name], value);
  }
  return out;
}

/**
 * Corpo de POST /data-quality/bulk-changes e /impact: `entity_type`, `filter`, `patch`, `reason` (mínimo em governanca.dados.bulk.motivo_minimo) e,
 * para campo crítico, `change_evidence` (a mesma do cadastro individual, M9-D807). Aceita snake_case e camelCase. Devolve também os hashes do pedido e do filtro.
 */
function parseBody(body, { reasonMin }) {
  if (!isPlainObject(body)) throw errors.validation('Corpo da requisição inválido.');
  const entityType = String(pick(body, 'entity_type', 'entityType') || '').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(FIELDS, entityType)) throw errors.validation('Tipo de cadastro inválido: use PERSON, PROPERTY ou SUPPLIER.', { field: 'entity_type' });
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < reasonMin) throw errors.validation(`Informe o motivo da alteração em massa (mínimo ${reasonMin} caracteres).`, { field: 'reason', minimum: reasonMin });
  const filter = parseFilter(entityType, body.filter);
  const patch = parsePatch(entityType, body.patch);
  const evidence = pick(body, 'change_evidence', 'changeEvidence') || null;
  return { entityType, filter, patch, reason, evidence, filterHash: sha256(filter), requestHash: sha256({ entityType, filter, patch, reason, evidence }) };
}

/** Idempotency-Key do cabeçalho: texto de 8 a 128 caracteres visíveis. */
function parseIdempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key.length < 8 || key.length > 128 || /[^\x21-\x7e]/.test(key)) throw errors.idempotencyRequired();
  return key;
}

module.exports = { parseBody, parseIdempotencyKey, canonical, sha256, UUID };
