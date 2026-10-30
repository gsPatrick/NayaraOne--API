'use strict';

const { getSetting } = require('../../settings/settings.service');
const { KEYS, RISK_LEVELS, FLAGS_SETTING_DEFAULTS: D } = require('./flags.settings');

const risk = (value, fallback) => (RISK_LEVELS.includes(value) ? value : fallback);

/** Parâmetros efetivos do registro na empresa; valor inválido volta ao padrão (nunca valor fixo no código). */
async function readFlagsParams(tenant, transaction) {
  const scope = { groupId: tenant.groupId, companyId: tenant.companyId };
  const get = (key) => getSetting(key, scope, transaction, D[key]);
  const max = Number(await get(KEYS.valueMax));
  return {
    defaultRisk: risk(await get(KEYS.defaultRisk), D[KEYS.defaultRisk]),
    absorbedRisk: risk(await get(KEYS.absorbedRisk), D[KEYS.absorbedRisk]),
    switchRisk: risk(await get(KEYS.switchRisk), D[KEYS.switchRisk]),
    valueMax: Number.isInteger(max) && max >= 100 ? max : D[KEYS.valueMax],
  };
}

module.exports = { readFlagsParams };
