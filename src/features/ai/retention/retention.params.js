'use strict';

const { getSetting } = require('../../settings/settings.service');
const { RETENTION_KEYS: K, RETENTION_SETTING_DEFAULTS: D } = require('./retention.settings');

async function readInt(key, ctx, transaction) {
  const n = Number(await getSetting(key, ctx, transaction, D[key]));
  return Number.isInteger(n) && n >= 1 ? n : D[key];
}

/** Prazos de retenção da empresa (dias) e intervalo do job (horas); valor inválido volta ao padrão. */
async function readRetentionParams(ctx, transaction) {
  const [publicDias, internalDias, confidentialDias, restrictedDias, intervaloHoras] = await Promise.all([
    readInt(K.public, ctx, transaction), readInt(K.internal, ctx, transaction), readInt(K.confidential, ctx, transaction),
    readInt(K.restricted, ctx, transaction), readInt(K.intervalHours, ctx, transaction),
  ]);
  return { publicDias, internalDias, confidentialDias, restrictedDias, intervaloHoras };
}

module.exports = { readRetentionParams };
