'use strict';

const { getSetting } = require('../../settings/settings.service');
const { MEMORY_KEYS: K, MEMORY_SETTING_DEFAULTS: D } = require('./memory.settings');
const { MEMORY_TYPES } = require('./memory.constants');

async function readInt(key, ctx, transaction) {
  const n = Number(await getSetting(key, ctx, transaction, D[key]));
  return Number.isInteger(n) && n >= 1 ? n : D[key];
}

/** Lista de tipos separados por vírgula; nome que não é tipo da memória é ignorado. */
function parseTypes(raw) {
  const text = typeof raw === 'string' ? raw : D[K.piiTypes];
  return new Set(text.split(',').map((t) => t.trim().toUpperCase()).filter((t) => MEMORY_TYPES.includes(t)));
}

/** Parâmetros da empresa para a memória; valor inválido volta ao padrão. */
async function readMemoryParams(ctx, transaction) {
  const [valueMax, validityDays, maxContextItems, transcriptHours, transcriptMax, sessionDays, expiryIntervalHours, piiRaw] = await Promise.all([
    readInt(K.valueMax, ctx, transaction), readInt(K.validityDays, ctx, transaction), readInt(K.maxContextItems, ctx, transaction),
    readInt(K.transcriptHours, ctx, transaction), readInt(K.transcriptMax, ctx, transaction), readInt(K.sessionDays, ctx, transaction),
    readInt(K.expiryIntervalHours, ctx, transaction), getSetting(K.piiTypes, ctx, transaction, D[K.piiTypes]),
  ]);
  return { valueMax, validityDays, maxContextItems, transcriptHours, transcriptMax, sessionDays, expiryIntervalHours, piiTypes: parseTypes(piiRaw) };
}

module.exports = { readMemoryParams, parseTypes };
