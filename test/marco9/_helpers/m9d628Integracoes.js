'use strict';

// Fontes de integrações, bloqueios e autenticação da M9-D628. Fornecedores do catálogo: messaging-sandbox (HIGH, SLO 99,5% => limite de erro 0,50) e portal-sandbox (MEDIUM, 99,0% => 1,00).
const env628 = require('./m9d628Env');

const connection = (env, t, providerCode, environment, status = 'ACTIVE') => env628.seed(env, t, 'integration.connections', {
  provider_code: providerCode, environment, label: `m9d628 ${env628.uuid()}`, status, ...(environment === 'PRODUCTION' && status === 'ACTIVE' ? { production_released_at: '2026-10-01T12:00:00Z', production_released_by: t.userId } : {}),
});

function health(env, t, conn, provider, windowStart, windowMinutes, v) {
  return env628.seed(env, t, 'integration.provider_health', {
    connection_id: conn, provider_code: provider, window_start: windowStart, window_minutes: windowMinutes, calls_total: v.total, calls_success: v.total - v.failed, calls_failed: v.failed,
    latency_p95_ms: v.p95 ?? null, latency_p99_ms: v.p99 ?? null, rate_limit_count: v.rate || 0, auth_failures: v.auth || 0, retries_total: v.retries || 0, dlq_count: v.dlq || 0,
    backlog_count: v.backlog || 0, quota_remaining: v.quota ?? null, updated_at: windowStart,
  });
}

async function integracoes(env, t) {
  const a = await connection(env, t, 'messaging-sandbox', 'SANDBOX');
  const b = await connection(env, t, 'messaging-sandbox', 'PRODUCTION');
  const c = await connection(env, t, 'portal-sandbox', 'PRODUCTION');
  const draft = await connection(env, t, 'portal-sandbox', 'PRODUCTION', 'DRAFT');
  await health(env, t, a, 'messaging-sandbox', '2026-10-28T13:00:00Z', 60, { total: 999, failed: 999 }); // janela antiga: fora
  await health(env, t, a, 'messaging-sandbox', '2026-10-28T14:00:00Z', 60, { total: 100, failed: 10, p95: 300, p99: 900, rate: 2, auth: 1, retries: 5, dlq: 1, backlog: 3, quota: 50 });
  await health(env, t, b, 'messaging-sandbox', '2026-10-28T14:00:00Z', 60, { total: 100, failed: 2, p95: 500, p99: 800, quota: 70 });
  await health(env, t, a, 'messaging-sandbox', '2026-10-28T14:55:00Z', 5, { total: 4, failed: 1, p95: 100, p99: 120 });
  await health(env, t, c, 'portal-sandbox', '2026-10-28T14:00:00Z', 60, { total: 0, failed: 0 });
  await health(env, t, draft, 'portal-sandbox', '2026-10-28T14:00:00Z', 60, { total: 50, failed: 25 }); // connection fora de ACTIVE: fora
  return { a, b, c, draft };
}

async function autenticacao(env, t, conns) {
  for (const [actor, iso] of [['ana@exemplo.com', '2026-10-28T10:05:00Z'], ['ana@exemplo.com', '2026-10-28T10:20:00Z'], ['bia@exemplo.com', '2026-10-28T11:10:00Z']]) {
    await env628.signal(env, { kind: 'LOGIN_FAILURE', actor, ip: '203.0.113.9', occurredAt: iso });
  }
  await env628.signal(env, { kind: 'MFA_FAILURE', actor: 'usuario-1', ip: '203.0.113.9', occurredAt: '2026-10-28T11:30:00Z' });
  const error = (cls, iso) => env628.seed(env, t, 'integration.integration_errors', {
    connection_id: conns.a, provider_code: 'messaging-sandbox', source: 'DISPATCH', error_class: cls, error_code: 'X', severity: 'HIGH', message: 'falha', created_at: iso,
  });
  await error('AUTH', '2026-10-28T13:00:00Z');
  await error('AUTH', '2026-10-28T13:10:00Z');
  await error('TRANSIENT', '2026-10-28T13:20:00Z');
}

async function bloqueios(env, t) {
  const run = (reason, iso, status = 'BLOCKED') => env628.seed(env, t, 'marketing.automation_runs', {
    automation_version_id: env628.uuid(), correlation_id: env628.uuid(), idempotency_key: `m9d628-${env628.uuid()}`, status, blocked_reason: reason, started_at: iso, created_at: iso, updated_at: iso,
  });
  await run('NO_CONSENT', '2026-10-28T12:00:00Z');
  await run('SUPPRESSED', '2026-10-28T12:10:00Z');
  await run('CAMPAIGN_KILL_SWITCH_ACTIVE', '2026-10-28T12:20:00Z');
  await run(null, '2026-10-28T12:30:00Z');
  await run('QUIET_HOURS', '2026-10-28T12:40:00Z');
  await run('NO_CONSENT', '2026-10-28T02:30:00Z'); // 23:30 de 27/10 em São Paulo
  await run(null, '2026-10-28T12:50:00Z', 'STARTED'); // não bloqueada: fora
  for (let i = 0; i < 2; i += 1) {
    await env628.seed(env, t, 'audit.audit_log', { action: 'finance.transfer.blocked', entity_type: 'Transfer', occurred_at: '2026-10-28T13:00:00Z', created_at: '2026-10-28T13:00:00Z' });
  }
  const dispatch = (cls, status) => env628.seed(env, t, 'integration.dispatches', {
    connection_id: env628.uuid(), provider_code: 'portal-sandbox', operation: 'publishListing', payload_snapshot: '{}', payload_hash: 'a'.repeat(64), idempotency_key: `m9d628-${env628.uuid()}`, max_attempts: 3,
    status, last_error_class: cls, created_at: '2026-10-28T13:30:00Z', updated_at: '2026-10-28T13:30:00Z',
  });
  await dispatch('VALIDATION', 'FAILED');
  await dispatch('TRANSIENT', 'FAILED');
}

module.exports = { integracoes, autenticacao, bloqueios };
