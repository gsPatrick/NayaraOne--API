'use strict';

const { definePort } = require('../ports/definePort');

/** Port AnalyticsAdapter (domínio ANALYTICS, M9-D209): operações, entradas e saída normalizada versionadas. */
const AnalyticsAdapter = definePort('AnalyticsAdapter', 'ANALYTICS', {
  emitMetric: ['name'],
  emitEvent: ['name'],
  queryHealth: [],
});

module.exports = { AnalyticsAdapter };
