'use strict';

/**
 * M9-D431 — Parâmetro da atribuição (Marketing). Padrão do livro (MKT-P053): janela de 90 dias para first-touch e last-touch. É o
 * ÚNICO parâmetro do modelo; o BI (M9-D670) lê os papéis gravados e não reatribui. SETTINGS_SCHEMA fail-closed + getSetting.
 */
const WINDOW_DAYS_KEY = 'marketing.attribution.janela_dias';
const TRACKING_SETTING_DEFAULTS = Object.freeze({ [WINDOW_DAYS_KEY]: 90 });
const TRACKING_SETTINGS_SCHEMA = { [WINDOW_DAYS_KEY]: { type: 'integer', min: 1, max: 3650 } };

async function readWindowDays(tenant, transaction) {
  const { getSetting } = require('../../../features/settings/settings.service');
  const value = Number(await getSetting(WINDOW_DAYS_KEY, tenant, transaction, TRACKING_SETTING_DEFAULTS[WINDOW_DAYS_KEY]));
  return Number.isInteger(value) && value >= 1 ? value : TRACKING_SETTING_DEFAULTS[WINDOW_DAYS_KEY];
}

module.exports = { WINDOW_DAYS_KEY, TRACKING_SETTING_DEFAULTS, TRACKING_SETTINGS_SCHEMA, readWindowDays };
