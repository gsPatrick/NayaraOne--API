'use strict';

const AppError = require('../../../utils/AppError');
const { parseSlo } = require('./sloParse');

/**
 * Parâmetros da saúde dos fornecedores (M9-D206). Dicionário fail-closed de SETTINGS_SCHEMA; a leitura com os
 * padrões do parametros.csv está em healthParams.js. A meta de SLO por criticidade é um texto que a M9-D225 edita.
 */
const sloSpec = {
  type: 'string',
  validate: (key, value) => {
    const slo = parseSlo(value);
    if (!slo || slo.minSuccessRate <= 0 || slo.minSuccessRate > 100 || slo.p95Ms <= 0 || slo.p99Ms < slo.p95Ms) {
      throw AppError.badRequest(`O valor de "${key}" deve seguir o formato "99.5% / p95 5 s / p99 12 s / backlog 15 min" (p99 não menor que p95).`, 'SETTING_INVALID_VALUE', { key, value });
    }
  },
};

const HEALTH_SETTINGS_SCHEMA = Object.freeze({
  'integration.health.stale_after_s': { type: 'integer', min: 30, max: 86400 },
  'integration.health.aggregate_interval_s': { type: 'integer', min: 10, max: 3600 },
  'integration.health.history_retention_days': { type: 'integer', min: 1, max: 3650 },
  'integration.health.down_after_failures': { type: 'integer', min: 1, max: 20 },
  'integration.slo.CRITICAL': sloSpec,
  'integration.slo.HIGH': sloSpec,
  'integration.slo.MEDIUM': sloSpec,
  'integration.slo.LOW': sloSpec,
});

module.exports = { HEALTH_SETTINGS_SCHEMA };
