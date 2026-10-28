'use strict';

const { sequelize } = require('../../../models');

/**
 * Acesso SQL a integration.provider_health. Tudo recebe a transação do tenant (RLS FORCE por app.company_id).
 * As linhas voltam como vêm do banco (snake_case).
 */
const q = (sql, replacements, transaction, type) => sequelize.query(sql, { replacements, transaction, type });
const SELECT = sequelize.QueryTypes.SELECT;

async function findCurrentRow(connectionId, transaction) {
  const rows = await q('SELECT * FROM "integration"."provider_health" WHERE connection_id = :id AND window_minutes = 0', { id: connectionId }, transaction, SELECT);
  return rows[0] || null;
}

/** Cria a linha ATUAL se ainda não existir (idempotente, sem corrida: o índice parcial é a trava). */
async function ensureCurrentRow(connection, now, transaction) {
  await q(
    `INSERT INTO "integration"."provider_health" (group_id, company_id, connection_id, provider_code, window_start, window_minutes, updated_at)
     VALUES (:g, :c, :id, :p, :now, 0, :now)
     ON CONFLICT (connection_id) WHERE window_minutes = 0 DO NOTHING`,
    { g: connection.groupId, c: connection.companyId, id: connection.id, p: connection.providerCode, now },
    transaction,
  );
  return findCurrentRow(connection.id, transaction);
}

const METRIC_COLUMNS = [
  ['calls_total', 'callsTotal'], ['calls_success', 'callsSuccess'], ['calls_failed', 'callsFailed'], ['success_rate', 'successRate'],
  ['latency_p50_ms', 'latencyP50Ms'], ['latency_p95_ms', 'latencyP95Ms'], ['latency_p99_ms', 'latencyP99Ms'],
  ['rate_limit_count', 'rateLimitCount'], ['auth_failures', 'authFailures'], ['retries_total', 'retriesTotal'],
  ['dlq_count', 'dlqCount'], ['backlog_count', 'backlogCount'],
];

function metricReplacements(metrics, quota) {
  const rep = Object.fromEntries(METRIC_COLUMNS.map(([, key]) => [key, metrics[key] ?? null]));
  return { ...rep, qLimit: quota?.limit ?? null, qRemaining: quota?.remaining ?? null, qResets: quota?.resetsAt ?? null };
}

/** Grava (ou regrava) a janela agregada; repetir o job na mesma janela atualiza a mesma linha. */
async function upsertWindow(connection, windowMinutes, windowStart, metrics, quota, now, transaction) {
  const cols = METRIC_COLUMNS.map(([c]) => c);
  const vals = METRIC_COLUMNS.map(([, k]) => `:${k}`);
  const upd = cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  await q(
    `INSERT INTO "integration"."provider_health"
       (group_id, company_id, connection_id, provider_code, window_start, window_minutes, ${cols.join(', ')},
        quota_limit, quota_remaining, quota_resets_at, updated_at)
     VALUES (:g, :c, :id, :p, :ws, :wm, ${vals.join(', ')}, :qLimit, :qRemaining, :qResets, :now)
     ON CONFLICT (connection_id, window_minutes, window_start) DO UPDATE SET ${upd},
       quota_limit = EXCLUDED.quota_limit, quota_remaining = EXCLUDED.quota_remaining, quota_resets_at = EXCLUDED.quota_resets_at,
       updated_at = EXCLUDED.updated_at`,
    { g: connection.groupId, c: connection.companyId, id: connection.id, p: connection.providerCode, ws: windowStart, wm: windowMinutes, now, ...metricReplacements(metrics, quota) },
    transaction,
  );
}

/** Copia as métricas da janela deslizante para a linha ATUAL (sem tocar em circuito nem health check). */
async function writeCurrentMetrics(connectionId, metrics, quota, lastSampleAt, healthStatus, now, transaction) {
  const set = METRIC_COLUMNS.map(([c, k]) => `${c} = :${k}`).join(', ');
  const rows = await q(
    `UPDATE "integration"."provider_health" SET ${set},
       quota_limit = :qLimit, quota_remaining = :qRemaining, quota_resets_at = :qResets,
       last_sample_at = GREATEST(last_sample_at, CAST(:ls AS timestamptz)), health_status = :hs, updated_at = :now
     WHERE connection_id = :id AND window_minutes = 0 RETURNING *`,
    { id: connectionId, ls: lastSampleAt, hs: healthStatus, now, ...metricReplacements(metrics, quota) },
    transaction,
    SELECT,
  );
  return rows[0];
}

async function writeStatus(connectionId, healthStatus, now, transaction) {
  const rows = await q(
    `UPDATE "integration"."provider_health" SET health_status = :hs, updated_at = :now
     WHERE connection_id = :id AND window_minutes = 0 RETURNING *`,
    { id: connectionId, hs: healthStatus, now },
    transaction,
    SELECT,
  );
  return rows[0];
}

module.exports = { findCurrentRow, ensureCurrentRow, upsertWindow, writeCurrentMetrics, writeStatus, q, SELECT };
