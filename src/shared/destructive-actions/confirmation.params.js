'use strict';

const { getSetting } = require('../../features/settings/settings.service');
const { UI_SETTING_DEFAULTS, LEVELS_KEY, TOKEN_TTL_KEY, ITEMS_MAX_KEY } = require('../../features/core-governance/governance.ui.settings');
const { DLP_SETTING_DEFAULTS } = require('../../features/core-governance/dlp/dlp.settings');

const JUSTIFICATION_KEY = 'governanca.dlp.justificativa_min';
const intOr = (value, fallback) => (Number.isInteger(value) && value >= 1 ? value : fallback);

/** Parâmetros que a confirmação lê da empresa (nunca valor fixo no código): níveis por ação, validade do token, itens listados e mínimo da justificativa. */
async function readParams(tenant, transaction) {
  const [levelsText, ttl, itemsMax, justification] = await Promise.all([
    getSetting(LEVELS_KEY, tenant, transaction, UI_SETTING_DEFAULTS[LEVELS_KEY]),
    getSetting(TOKEN_TTL_KEY, tenant, transaction, UI_SETTING_DEFAULTS[TOKEN_TTL_KEY]),
    getSetting(ITEMS_MAX_KEY, tenant, transaction, UI_SETTING_DEFAULTS[ITEMS_MAX_KEY]),
    getSetting(JUSTIFICATION_KEY, tenant, transaction, DLP_SETTING_DEFAULTS[JUSTIFICATION_KEY]),
  ]);
  return {
    levelsText: typeof levelsText === 'string' ? levelsText : UI_SETTING_DEFAULTS[LEVELS_KEY],
    ttlMinutes: intOr(ttl, UI_SETTING_DEFAULTS[TOKEN_TTL_KEY]),
    itemsMax: intOr(itemsMax, UI_SETTING_DEFAULTS[ITEMS_MAX_KEY]),
    justificationMin: intOr(justification, DLP_SETTING_DEFAULTS[JUSTIFICATION_KEY]),
  };
}

module.exports = { readParams };
