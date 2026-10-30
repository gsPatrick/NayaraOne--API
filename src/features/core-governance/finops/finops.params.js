'use strict';

const { getSetting } = require('../../settings/settings.service');
const { KEYS, FINOPS_SETTING_DEFAULTS, DEFAULT_PRICES, parsePrices } = require('./finops.settings');

/** Lê os parâmetros do FinOps da empresa (nunca valor fixo no código: o padrão é o do catálogo). */
async function readFinopsParams(tenant, transaction) {
  const get = (key) => getSetting(key, tenant, transaction, FINOPS_SETTING_DEFAULTS[key]);
  const prices = parsePrices(await get(KEYS.prices)) || parsePrices(DEFAULT_PRICES);
  return {
    currency: await get(KEYS.currency),
    environment: await get(KEYS.environment),
    prices,
    gbBase: Number(await get(KEYS.gbBase)) === 1000 ? 1000n : 1024n,
    storageHour: Number(await get(KEYS.storageHour)),
    windowDays: Number(await get(KEYS.windowDays)),
  };
}

module.exports = { readFinopsParams };
