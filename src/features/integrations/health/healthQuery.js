'use strict';

const { loadConnection, loadHealthContext, statusOf } = require('./healthContext');
const { findCurrentRow } = require('./healthStore');

const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Visão atual da saúde de uma connection (para a API administrativa de M9-D249 e para as telas). O estado é
 * recalculado na leitura com os parâmetros vigentes: dado velho vira UNKNOWN mesmo que o job tenha parado.
 * Connection de outra empresa: 404 INTEGRATION_CONNECTION_NOT_FOUND.
 */
async function getCurrentHealth(connectionId, ctx, transaction, { now = new Date() } = {}) {
  const connection = await loadConnection(connectionId, transaction);
  const healthCtx = await loadHealthContext(connection, transaction);
  const row = await findCurrentRow(connectionId, transaction);
  const base = { connectionId, providerCode: connection.providerCode, criticality: healthCtx.criticality, slo: healthCtx.slo };
  if (!row) return { ...base, healthStatus: 'UNKNOWN', circuitState: 'CLOSED', lastCheckAt: null };
  return {
    ...base,
    healthStatus: statusOf(row, healthCtx, now),
    circuitState: row.circuit_state,
    circuitOpenedAt: row.circuit_opened_at,
    circuitCooldownS: row.circuit_cooldown_s,
    consecutiveFailures: row.consecutive_failures,
    halfOpenSuccesses: row.half_open_successes,
    callsTotal: row.calls_total,
    successRate: num(row.success_rate),
    latencyP50Ms: row.latency_p50_ms,
    latencyP95Ms: row.latency_p95_ms,
    latencyP99Ms: row.latency_p99_ms,
    rateLimitCount: row.rate_limit_count,
    authFailures: row.auth_failures,
    retriesTotal: row.retries_total,
    dlqCount: row.dlq_count,
    backlogCount: row.backlog_count,
    quotaLimit: row.quota_limit,
    quotaRemaining: row.quota_remaining,
    quotaResetsAt: row.quota_resets_at,
    lastSampleAt: row.last_sample_at,
    lastCheckAt: row.last_check_at,
    lastCheckOk: row.last_check_ok,
    lastCheckLatencyMs: row.last_check_latency_ms,
    updatedAt: row.updated_at,
  };
}

module.exports = { getCurrentHealth };
