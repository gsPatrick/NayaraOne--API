'use strict';

const AppError = require('../../../utils/AppError');
const { collectSample } = require('./sampleSources');
const { aggregateSamples } = require('./aggregateSamples');

/**
 * As 8 métricas do livro (seção 17) publicadas em 9 valores, porque a latência tem p95 e p99 (auditoria cega C10, M9-D224):
 * success_rate, latency p95/p99, rate_limit_count, auth_failures, retries, DLQ, backlog e quota_remaining. É a lista única que o painel,
 * a API administrativa (M9-D249) e os alertas usam.
 */
const METRIC_KEYS = Object.freeze(['successRate', 'latencyP95Ms', 'latencyP99Ms', 'rateLimitCount', 'authFailures', 'retries', 'dlq', 'backlog', 'quotaRemaining']);

/** As janelas do livro: 5 minutos, 1 hora e 1 dia (minutos corridos até agora). */
const METRIC_WINDOWS = Object.freeze({ '5m': 5, '1h': 60, '1d': 1440 });
const MIN_MS = 60000;

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** A partir do resultado de aggregateSamples (camelCase) e da cota da amostra. */
function metricsFromAggregate(m, quota) {
  return {
    successRate: num(m.successRate),
    latencyP95Ms: num(m.latencyP95Ms),
    latencyP99Ms: num(m.latencyP99Ms),
    rateLimitCount: Number(m.rateLimitCount || 0),
    authFailures: Number(m.authFailures || 0),
    retries: Number(m.retriesTotal || 0),
    dlq: Number(m.dlqCount || 0),
    backlog: Number(m.backlogCount || 0),
    quotaRemaining: quota ? num(quota.remaining) : null,
  };
}

/** A partir de uma linha de integration.provider_health (snake_case). */
function metricsFromRow(row) {
  return {
    successRate: num(row.success_rate),
    latencyP95Ms: num(row.latency_p95_ms),
    latencyP99Ms: num(row.latency_p99_ms),
    rateLimitCount: Number(row.rate_limit_count || 0),
    authFailures: Number(row.auth_failures || 0),
    retries: Number(row.retries_total || 0),
    dlq: Number(row.dlq_count || 0),
    backlog: Number(row.backlog_count || 0),
    quotaRemaining: num(row.quota_remaining),
  };
}

/** Amostra e métricas da connection na janela corrida que termina em `now` (fonte: dispatches, tentativas e caixa de entrada de webhooks). */
async function getWindowSample(connection, windowKey, now, transaction) {
  const minutos = METRIC_WINDOWS[windowKey];
  if (!minutos) throw AppError.unprocessable('Parâmetro de consulta inválido.', 'VALIDATION_ERROR', { campo: 'window' });
  const sample = await collectSample({ connection, from: new Date(now.getTime() - minutos * MIN_MS), to: now, windowMinutes: minutos }, transaction);
  const aggregate = aggregateSamples(sample);
  return { sample, aggregate, metrics: metricsFromAggregate(aggregate, sample.quota) };
}

/** Os 9 valores das 8 métricas do livro numa janela ('5m', '1h' ou '1d'). */
async function getWindowMetrics(connection, windowKey, now, transaction) {
  return (await getWindowSample(connection, windowKey, now, transaction)).metrics;
}

module.exports = { METRIC_KEYS, METRIC_WINDOWS, metricsFromAggregate, metricsFromRow, getWindowSample, getWindowMetrics };
