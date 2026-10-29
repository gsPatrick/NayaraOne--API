'use strict';

const { getSetting } = require('../../settings/settings.service');
const { RECOMMENDATION_KEYS: K, RECOMMENDATION_SETTING_DEFAULTS: D } = require('./recommendation.settings');

async function readInt(key, ctx, transaction) {
  const n = Number(await getSetting(key, ctx, transaction, D[key]));
  return Number.isInteger(n) && n >= 1 ? n : D[key];
}

async function readBool(key, ctx, transaction) {
  const raw = await getSetting(key, ctx, transaction, D[key]);
  return typeof raw === 'boolean' ? raw : D[key];
}

/** Parâmetros da empresa para recomendações; valor inválido volta ao padrão. */
async function readRecommendationParams(ctx, transaction) {
  const [rationaleMax, listMax, reasonRequired, distinctApprover] = await Promise.all([
    readInt(K.rationaleMax, ctx, transaction), readInt(K.listMax, ctx, transaction),
    readBool(K.reasonRequired, ctx, transaction), readBool(K.distinctApprover, ctx, transaction),
  ]);
  return { rationaleMax, listMax, reasonRequired, distinctApprover };
}

module.exports = { readRecommendationParams };
