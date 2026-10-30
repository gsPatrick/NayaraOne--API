'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { readFinopsParams } = require('../finops.params');
const { KEYS, DETECTOR_SETTING_DEFAULTS } = require('./detectors.settings');

/** Parâmetros dos detectores da empresa (nunca valor fixo no código) mais os de preço e base de GB do FinOps. */
async function readDetectorParams(tenant, transaction) {
  const get = async (key) => Number(await getSetting(key, tenant, transaction, DETECTOR_SETTING_DEFAULTS[key]));
  return {
    finops: await readFinopsParams(tenant, transaction),
    orphanDays: await get(KEYS.orphanDays), logFactor: await get(KEYS.logFactor), egressFactor: await get(KEYS.egressFactor), averageDays: await get(KEYS.averageDays),
    queueMax: await get(KEYS.queueMax), queueOldMin: await get(KEYS.queueOldMin), queueAgeMin: await get(KEYS.queueAgeMin), aiCallCents: await get(KEYS.aiCallCents),
    detectorHour: await get(KEYS.detectorHour), queueInterval: await get(KEYS.queueInterval),
  };
}

module.exports = { readDetectorParams };
