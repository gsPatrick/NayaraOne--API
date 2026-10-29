'use strict';

/** Parâmetros do job de retenção (M9-D244): só o dicionário de SETTINGS_SCHEMA; a leitura está em retention.params.js. */
const RETENTION_SETTINGS_SCHEMA = Object.freeze({
  // Hora (America/Sao_Paulo) a partir da qual o job de retenção roda, uma vez por dia. Os prazos em si são os de cada tabela
  // (integration.health.history_retention_days, errors.retention_days, inbox.* e dispatch.*).
  'integration.retention.job_hour': { type: 'integer', min: 0, max: 23 },
});

module.exports = { RETENTION_SETTINGS_SCHEMA };
