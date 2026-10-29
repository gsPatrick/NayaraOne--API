'use strict';

/**
 * As 8 métricas do livro (seção 17) publicadas em 9 valores, porque a latência tem p95 e p99 (auditoria cega C10, M9-D224):
 * success_rate, latency p95/p99, rate_limit_count, auth_failures, retries, DLQ, backlog e quota_remaining.
 */
const METRIC_KEYS = Object.freeze(['successRate', 'latencyP95Ms', 'latencyP99Ms', 'rateLimitCount', 'authFailures', 'retries', 'dlq', 'backlog', 'quotaRemaining']);

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

module.exports = { METRIC_KEYS, metricsFromAggregate, metricsFromRow };
