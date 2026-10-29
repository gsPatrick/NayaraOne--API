'use strict';

/** APIs administrativas das integrações (Marco 9, M9-D249). */
const { listIntegrations } = require('./admin.list');
const { getProviderHealth, runbookPathOf } = require('./admin.health');
const { getDispatchDetail } = require('./admin.dispatch');
const { METRIC_KEYS } = require('./admin.metrics');

module.exports = { listIntegrations, getProviderHealth, getDispatchDetail, runbookPathOf, METRIC_KEYS };
