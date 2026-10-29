'use strict';

// M9-D696 — API pública da camada quality do BI: tipos de check, catálogo por read model, execução a cada refresh, estado do dataset e parâmetros.
const types = require('./types');
const catalog = require('./quality.catalog');
const settings = require('./quality.settings');
const sql = require('./quality.sql');
const { checkRefresh, EVENT_TYPE } = require('./quality.record');
const { executeChecks, ERROR_CODE } = require('./quality.execute');
const { datasetQuality } = require('./quality.dataset');
const listener = require('./quality.listener');
const priority = require('./status.priority');
const block = require('./status.block');
const transition = require('./status.transition');

require('./checks'); // carrega quality/checks/<read-model>.checks.js
listener.install(); // liga ao fim de cada lote de refresh e ao rebuild

module.exports = {
  camada: 'quality',
  ...priority, ...block, DEGRADED_EVENT: transition.DEGRADED_EVENT, RECOVERED_EVENT: transition.RECOVERED_EVENT,
  types, sql, checkRefresh, executeChecks, datasetQuality, EVENT_TYPE, ERROR_CODE,
  registerChecks: catalog.registerChecks, unregisterChecks: catalog.unregisterChecks, getChecks: catalog.getChecks,
  assertEveryReadModelDeclaresChecks: catalog.assertEveryReadModelDeclaresChecks,
  DEFAULTS: settings.DEFAULTS, QUALITY_SETTINGS_SCHEMA: settings.QUALITY_SETTINGS_SCHEMA, parseSeverities: settings.parseSeverities, readQualityParams: settings.readQualityParams,
};
