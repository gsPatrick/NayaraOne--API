'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { KEYS, DEGRADATION_SETTING_DEFAULTS: D, LEVELS, ALERT_THRESHOLDS } = require('./degradation.settings');

const int = (value, fallback, min, max) => (Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback);

/** Parâmetros efetivos da degradação na empresa; valor inválido volta ao padrão (nunca valor fixo no código). */
async function readDegradationParams(tenant, transaction) {
  const scope = { groupId: tenant.groupId, companyId: tenant.companyId };
  const get = (key) => getSetting(key, scope, transaction, D[key]);
  const enabled = await get(KEYS.enabled);
  const level = String(await get(KEYS.logLevel));
  const threshold = (value, fallback) => (ALERT_THRESHOLDS.includes(Number(value)) ? Number(value) : fallback);
  return {
    enabled: enabled !== false && enabled !== 'false',
    firstThreshold: threshold(await get(KEYS.firstThreshold), D[KEYS.firstThreshold]),
    otherThreshold: threshold(await get(KEYS.otherThreshold), D[KEYS.otherThreshold]),
    jobMinute: int(await get(KEYS.jobMinute), D[KEYS.jobMinute], 0, 59),
    logLevel: LEVELS.includes(level) ? level : D[KEYS.logLevel],
    exportPercent: int(await get(KEYS.exportPercent), D[KEYS.exportPercent], 1, 99),
    lowPriorityJobs: String(await get(KEYS.lowPriorityJobs) || '').split(',').map((s) => s.trim()).filter(Boolean),
    windowStart: int(await get(KEYS.windowStart), D[KEYS.windowStart], 0, 23),
    windowEnd: int(await get(KEYS.windowEnd), D[KEYS.windowEnd], 1, 24),
  };
}

module.exports = { readDegradationParams };
