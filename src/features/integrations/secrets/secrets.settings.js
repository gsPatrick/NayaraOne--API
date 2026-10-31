'use strict';

const AppError = require('../../../utils/AppError');

/** Parâmetros do cofre (M9-D202): só o dicionário de SETTINGS_SCHEMA (a leitura está em secretParams.js). */
const ALERT_DAYS_RE = /^\s*\d{1,3}(\s*,\s*\d{1,3})*\s*$/;

const SECRET_SETTINGS_SCHEMA = Object.freeze({
  'integration.secret.cache_ttl_s': { type: 'integer', min: 0, max: 3600 },
  'integration.secret.grace_period_min': { type: 'integer', min: 0, max: 1440 },
  'integration.secret.rotation_max_age_days.BANK': { type: 'integer', min: 1, max: 365 },
  'integration.secret.expiry_alert_days': {
    type: 'string',
    validate: (key, value) => {
      const lista = ALERT_DAYS_RE.test(value) ? value.split(',').map((x) => Number(x.trim())) : null;
      if (!lista || lista.some((n) => n < 1 || n > 365)) {
        throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de dias de 1 a 365 separados por vírgula (ex.: 30,14,7).`, 'SETTING_INVALID_VALUE', { key, value });
      }
    },
  },
  'integration.secret.require_company_prefix': { type: 'boolean', platformOnly: true },
  'integration.secret.mfa_on_bank_secret_change': { type: 'boolean' },
});

module.exports = { SECRET_SETTINGS_SCHEMA, ALERT_DAYS_RE };
