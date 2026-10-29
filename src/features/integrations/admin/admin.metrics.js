'use strict';

/** As 8 métricas do livro em 9 valores: a definição é única e mora em health/metrics.js (M9-D224); a API administrativa só as reexporta. */
const { METRIC_KEYS, metricsFromAggregate, metricsFromRow } = require('../health/metrics');

module.exports = { METRIC_KEYS, metricsFromAggregate, metricsFromRow };
