'use strict';

/** Parâmetros da sincronização (M9-D208): só o dicionário de SETTINGS_SCHEMA; a leitura está em sync.params.js. */
const SYNC_SETTINGS_SCHEMA = Object.freeze({
  'integration.sync.page_size': { type: 'integer', min: 1, max: 5000 },
  'integration.sync.lease_s': { type: 'integer', min: 10, max: 3600 },
  'integration.sync.overlap_s': { type: 'integer', min: 0, max: 86400 },
  'integration.sync.failures_to_stall': { type: 'integer', min: 1, max: 100 },
  'integration.sync.stalled_after_minutes.CRITICAL': { type: 'integer', min: 1, max: 10080 },
  'integration.sync.stalled_after_minutes.HIGH': { type: 'integer', min: 1, max: 10080 },
  'integration.sync.stalled_after_minutes.MEDIUM': { type: 'integer', min: 1, max: 10080 },
  'integration.sync.stalled_after_minutes.LOW': { type: 'integer', min: 1, max: 10080 },
});

module.exports = { SYNC_SETTINGS_SCHEMA };
