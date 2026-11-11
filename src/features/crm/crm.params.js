'use strict';

const { KEYS, CRM_SETTING_DEFAULTS, parseReasonList } = require('./crm.settings');

/**
 * Leitura dos parâmetros do CRM (crm.settings.js) para a empresa da transação. Valor ausente ou ilegível vale o padrão do
 * dicionário (nunca derruba o fluxo). Import tardio do settings.service: ele carrega crm.settings.js e as travas do CRM.
 */
function readSetting(key, tenant, transaction) {
  const { getSetting } = require('../settings/settings.service');
  return getSetting(key, tenant, transaction, CRM_SETTING_DEFAULTS[key]);
}

const reasonsOr = (value, fallback) => parseReasonList(value) || parseReasonList(fallback);
const positiveIntegerOr = (value, fallback, min = 1) => (Number.isInteger(value) && value >= min ? value : fallback);

/** Catálogo de motivos da empresa: { won, lost, withdrawal }, cada um [{ code, label }]. LOST aceita perda e desistência. */
async function readOutcomeReasonCatalog(tenant, transaction) {
  const won = await readSetting(KEYS.wonReasons, tenant, transaction);
  const lost = await readSetting(KEYS.lostReasons, tenant, transaction);
  const withdrawal = await readSetting(KEYS.withdrawalReasons, tenant, transaction);
  return {
    won: reasonsOr(won, CRM_SETTING_DEFAULTS[KEYS.wonReasons]),
    lost: reasonsOr(lost, CRM_SETTING_DEFAULTS[KEYS.lostReasons]),
    withdrawal: reasonsOr(withdrawal, CRM_SETTING_DEFAULTS[KEYS.withdrawalReasons]),
  };
}

/** SLA da ocorrência em horas por severidade (HIGH, MEDIUM, LOW). */
async function readSlaHoursBySeverity(tenant, transaction) {
  const high = await readSetting(KEYS.slaHigh, tenant, transaction);
  const medium = await readSetting(KEYS.slaMedium, tenant, transaction);
  const low = await readSetting(KEYS.slaLow, tenant, transaction);
  return {
    HIGH: positiveIntegerOr(high, CRM_SETTING_DEFAULTS[KEYS.slaHigh]),
    MEDIUM: positiveIntegerOr(medium, CRM_SETTING_DEFAULTS[KEYS.slaMedium]),
    LOW: positiveIntegerOr(low, CRM_SETTING_DEFAULTS[KEYS.slaLow]),
  };
}

async function readTaskManagerAfterHours(tenant, transaction) {
  const value = await readSetting(KEYS.taskManagerAfterHours, tenant, transaction);
  return positiveIntegerOr(value, CRM_SETTING_DEFAULTS[KEYS.taskManagerAfterHours], 0);
}

async function readManagerPermission(tenant, transaction) {
  const value = await readSetting(KEYS.managerPermission, tenant, transaction);
  return typeof value === 'string' && value.trim() ? value.trim() : CRM_SETTING_DEFAULTS[KEYS.managerPermission];
}

async function readDefaultLeadOwner(tenant, transaction) {
  const value = await readSetting(KEYS.defaultLeadOwner, tenant, transaction);
  return typeof value === 'string' && value ? value : null;
}

module.exports = {
  readOutcomeReasonCatalog,
  readSlaHoursBySeverity,
  readTaskManagerAfterHours,
  readManagerPermission,
  readDefaultLeadOwner,
};
