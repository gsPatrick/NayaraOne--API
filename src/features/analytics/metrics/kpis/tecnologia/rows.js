'use strict';

/**
 * M9-D680 — leitura dos read models de Tecnologia para o cálculo dos KPIs. Só lê o schema analytics (nunca o OLTP): o valor sai do estado que o worker de read models gravou
 * (M9-D607). Idades e estados que dependem da hora da leitura (fila sem medição, freshness) saem do relógio injetável do BI. As tabelas vêm das definições.
 */
const { sequelize } = require('../../../../../models');
const clock = require('../../clock');
const { classify, ageMinutesBetween } = require('../../freshness');
const { DEFINITIONS } = require('./definitions');
const { latestSnapshotAt } = require('../legalCor/snapshotAt');

const T = Object.freeze(Object.fromEntries(DEFINITIONS.map((d) => [d.metricCode, d.sourceReadModel])));
const select = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];
const monthStart = (day) => `${day.slice(0, 7)}-01`;
const text = (v) => (v === null || v === undefined ? null : String(v));

async function loadTechRows(scope, asOfDate, settings, transaction) {
  const base = { companyId: scope.companyId, asOf: asOfDate, from: monthStart(asOfDate), windowMinutes: settings.windowMinutes };
  const now = clock.now();
  const availability = await select(`SELECT probe, checks, up, expected FROM analytics.${T['tec.availability']} WHERE company_id = :companyId AND day >= CAST(:from AS date) AND day <= CAST(:asOf AS date) ORDER BY probe, day`, base, transaction);
  const queues = (await select(
    `SELECT queue, event_type AS "eventType", depth, dlq_depth AS "dlqDepth", CASE WHEN oldest_at IS NULL OR source_snapshot_at IS NULL THEN NULL ELSE GREATEST(0, EXTRACT(EPOCH FROM (source_snapshot_at - oldest_at))::int) END AS "oldestAgeSeconds"
       FROM analytics.${T['tec.queues_dlq']} WHERE company_id = :companyId ORDER BY queue, event_type`, base, transaction
  ));
  const integrations = (await select(
    `SELECT provider, family, environment, calls, errors, success_rate AS "successRate", latency_p95_ms AS "latencyP95Ms", latency_p99_ms AS "latencyP99Ms", rate_limit_count AS "rateLimitCount",
            auth_failures AS "authFailures", retries, dlq, backlog, quota_remaining AS "quotaRemaining", error_limit_pct AS "errorLimitPct"
       FROM analytics.${T['tec.integration_errors']} WHERE company_id = :companyId AND window_minutes = :windowMinutes ORDER BY provider, environment, family`, base, transaction
  )).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, text(v)])));
  const freshness = (await select(`SELECT read_model AS "readModel", max_age_minutes AS "limit", last_snapshot_at AS "lastSnapshotAt" FROM analytics.${T['tec.freshness']} WHERE company_id = :companyId ORDER BY read_model`, base, transaction))
    .map((r) => {
      const ageMinutes = ageMinutesBetween(r.lastSnapshotAt, now);
      return { readModel: r.readModel, ageMinutes, state: classify(ageMinutes, r.limit, settings.freshness.factor) };
    });
  const auth = await select(`SELECT kind, provider, failures, distinct_actors AS "distinctActors", peak_hour_failures AS "peakHourFailures" FROM analytics.${T['tec.auth_failures']} WHERE company_id = :companyId AND day = CAST(:asOf AS date) ORDER BY kind, provider`, base, transaction);
  const [log] = await select(`SELECT count(*)::int AS n FROM analytics.${T['tec.availability']} WHERE company_id = :companyId`, base, transaction);
  const blocked = await select(`SELECT reason, event_type AS "eventType", blocked FROM analytics.${T['tec.blocked_events']} WHERE company_id = :companyId AND day = CAST(:asOf AS date) ORDER BY reason, event_type`, base, transaction);
  const at = (code) => latestSnapshotAt(scope.companyId, [T[code]], transaction);
  const queueAt = await at('tec.queues_dlq');
  return {
    availability, queues, integrations, freshness, auth, hasLog: log.n > 0, blocked,
    measurementAgeMinutes: queueAt ? ageMinutesBetween(queueAt, now) : null,
    snapshotAt: Object.fromEntries(await Promise.all(Object.keys(T).map(async (code) => [code, code === 'tec.queues_dlq' ? queueAt : await at(code)]))),
  };
}

module.exports = { loadTechRows, TECH_READ_MODELS: [...new Set(Object.values(T))] };
