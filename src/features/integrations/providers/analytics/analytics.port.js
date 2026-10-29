'use strict';

const { definePort } = require('../ports/definePort');
const { analytics } = require('../../minimization/mappers');

// O valor da métrica chega como texto decimal: o conteúdo aprovado do envio guarda números assim (normalizeSnapshot, M9-D214).
/** Port AnalyticsAdapter (domínio ANALYTICS, M9-D209): operações, entradas e saída normalizada versionadas. */
const AnalyticsAdapter = definePort('AnalyticsAdapter', 'ANALYTICS', {
  emitMetric: {
    required: ['name', 'value'],
    properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, value: { type: 'string', pattern: '^-?[0-9]+(\\.[0-9]+)?$' }, tags: { type: 'object' } },
    outputMapper: analytics.emitMetric,
  },
  emitEvent: {
    required: ['name'],
    properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, properties: { type: 'object' } },
    outputMapper: analytics.emitEvent,
  },
  queryHealth: [],
});

module.exports = { AnalyticsAdapter };
