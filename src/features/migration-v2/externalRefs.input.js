'use strict';

const errors = require('./externalRefs.errors');

const ENTITY_TYPES = Object.freeze(['PERSON', 'PROPERTY', 'SUPPLIER', 'CONTRACT', 'FINANCIAL_ENTRY', 'LEAD', 'VISIT', 'PROPOSAL', 'PROJECT', 'PROJECT_STAGE', 'LEGAL_CASE', 'LEGAL_DEADLINE']);
const KEY_MAX = 128;
const SYSTEM = /^[A-Z][A-Z0-9_]{1,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Chave exatamente como veio; só os espaços das pontas saem (zero à esquerda é dado, não ruído). */
function normalizeKey(value) {
  if (value === null || value === undefined) throw errors.keyRequired();
  const key = String(value).trim();
  if (!key) throw errors.keyRequired();
  if (key.length > KEY_MAX) throw errors.keyInvalid(KEY_MAX);
  return key;
}

function normalizeSystem(value) {
  const system = String(value === null || value === undefined ? '' : value).trim();
  if (!SYSTEM.test(system)) throw errors.systemInvalid();
  return system;
}

function normalizeEntityType(value) {
  if (!ENTITY_TYPES.includes(value)) throw errors.entityTypeInvalid(ENTITY_TYPES);
  return value;
}

/** Data de referência da consulta/vigência: Date, texto ISO ou ausente (agora). */
function normalizeInstant(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw errors.instantInvalid();
  return date;
}

function parseRegister(input) {
  const body = input || {};
  if (!UUID.test(String(body.entityId || ''))) throw errors.entityInvalid();
  return {
    entityType: normalizeEntityType(body.entityType),
    entityId: body.entityId,
    sourceSystem: normalizeSystem(body.sourceSystem),
    sourceKey: normalizeKey(body.sourceKey),
    isPrimary: typeof body.isPrimary === 'boolean' ? body.isPrimary : null,
    validFrom: normalizeInstant(body.validFrom),
    migrationRunId: body.migrationRunId && UUID.test(body.migrationRunId) ? body.migrationRunId : null,
  };
}

module.exports = { UUID, ENTITY_TYPES, KEY_MAX, normalizeKey, normalizeSystem, normalizeEntityType, normalizeInstant, parseRegister };
