'use strict';

/**
 * M9-D406 — Parâmetro do agendamento (Marketing). Padrão do livro (MKT-P030): 15 minutos de antecedência mínima. Mesmo padrão do
 * projeto: dicionário fail-closed em SETTINGS_SCHEMA (settings.service.js faz o spread) + getSetting(chave, tenant, transaction, padrão).
 */
const MIN_LEAD_KEY = 'marketing.schedule.min_antecedencia_min';
const PIPELINE_SETTING_DEFAULTS = Object.freeze({ [MIN_LEAD_KEY]: 15 });
const PIPELINE_SETTINGS_SCHEMA = { [MIN_LEAD_KEY]: { type: 'integer', min: 1, max: 10080 } };

async function readMinLeadMinutes(tenant, transaction) {
  const { getSetting } = require('../../../features/settings/settings.service');
  const value = Number(await getSetting(MIN_LEAD_KEY, tenant, transaction, PIPELINE_SETTING_DEFAULTS[MIN_LEAD_KEY]));
  return Number.isInteger(value) && value >= 1 ? value : PIPELINE_SETTING_DEFAULTS[MIN_LEAD_KEY];
}

module.exports = { MIN_LEAD_KEY, PIPELINE_SETTING_DEFAULTS, PIPELINE_SETTINGS_SCHEMA, readMinLeadMinutes };
