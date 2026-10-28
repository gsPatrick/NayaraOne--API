'use strict';

const { getSetting } = require('../../settings/settings.service');
const { ALERT_DAYS_RE } = require('./secrets.settings');

/** Leitura dos parâmetros do cofre, com o padrão do parametros.csv quando a empresa não configurou. */
const PADROES = Object.freeze({
  cacheTtlS: 60, graceMin: 30, bankMaxAgeDays: 90, alertDays: '30,14,7', requireCompanyPrefix: true, mfaOnBankChange: true,
});

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

function parseAlertDays(texto) {
  const bruto = typeof texto === 'string' && ALERT_DAYS_RE.test(texto) ? texto : PADROES.alertDays;
  return [...new Set(bruto.split(',').map((x) => Number(x.trim())))].sort((a, b) => a - b);
}

async function readSecretParams(ctx, transaction) {
  const [ttl, grace, max, dias, prefixo, mfa] = await Promise.all([
    getSetting('integration.secret.cache_ttl_s', ctx, transaction, PADROES.cacheTtlS),
    getSetting('integration.secret.grace_period_min', ctx, transaction, PADROES.graceMin),
    getSetting('integration.secret.rotation_max_age_days.BANK', ctx, transaction, PADROES.bankMaxAgeDays),
    getSetting('integration.secret.expiry_alert_days', ctx, transaction, PADROES.alertDays),
    getSetting('integration.secret.require_company_prefix', ctx, transaction, PADROES.requireCompanyPrefix),
    getSetting('integration.secret.mfa_on_bank_secret_change', ctx, transaction, PADROES.mfaOnBankChange),
  ]);
  return {
    cacheTtlS: inteiro(ttl, PADROES.cacheTtlS, 0),
    graceMin: inteiro(grace, PADROES.graceMin, 0),
    bankMaxAgeDays: inteiro(max, PADROES.bankMaxAgeDays, 1),
    alertDays: parseAlertDays(dias),
    requireCompanyPrefix: prefixo !== false,
    mfaOnBankChange: mfa !== false,
  };
}

module.exports = { PADROES, readSecretParams, parseAlertDays };
