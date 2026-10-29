'use strict';

const { definePort } = require('../ports/definePort');
const { analytics } = require('../../minimization/mappers');

/** Port AnalyticsAdapter (domínio ANALYTICS, M9-D209): operações, entradas e saída normalizada versionadas. */
const AnalyticsAdapter = definePort('AnalyticsAdapter', 'ANALYTICS', {
  emitMetric: { required: ['name'], outputMapper: analytics.emitMetric },
  emitEvent: { required: ['name'], outputMapper: analytics.emitEvent },
  queryHealth: [],
});

module.exports = { AnalyticsAdapter };
