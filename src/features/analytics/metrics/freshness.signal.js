'use strict';

/**
 * M9-D609 (3.2, última regra) — alerta técnico `analytics.freshness.stale`: métrica CRITICAL cujo dado mais recente está STALE ou EXPIRED.
 * `collectCriticalStaleness` varre as métricas PUBLISHED e CRITICAL visíveis à empresa, mede a freshness do snapshot mais recente (valor
 * principal, dimensão vazia) e devolve as que passaram do limite. `signalCriticalStaleness` publica cada uma no evento técnico (log estruturado
 * e assinantes `onFreshnessStale`); quem abre a instância do alerta é o alert engine (M9-D691), que assina este evento. Só lê.
 */
const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const clock = require('./clock');
const { STATES, computeFreshness, maxStalenessOf } = require('./freshness');
const { readFreshnessParams } = require('./freshness.settings');

const EVENT_TYPE = 'analytics.freshness.stale';
const listeners = [];

/** fn(item) a cada métrica crítica vencida. Devolve a função que cancela a assinatura. */
function onFreshnessStale(fn) {
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

async function latestSnapshots(companyId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT ON (d.id) d.id AS "metricId", d.metric_code AS "metricCode", d.domain, d.name, v.refresh_policy AS "refreshPolicy",
            s.id AS "snapshotId", s.as_of_date::text AS "asOfDate", s.source_snapshot_at AS "sourceSnapshotAt", s.refreshed_at AS "refreshedAt"
       FROM analytics.metric_definitions d
       JOIN analytics.metric_versions v ON v.id = d.current_version_id
       JOIN analytics.metric_snapshots s ON s.metric_id = d.id AND s.scope_type = 'COMPANY' AND s.scope_id = :companyId AND s.dimension_key = ''
      WHERE d.status = 'PUBLISHED' AND d.criticality = 'CRITICAL' AND (d.company_id = :companyId OR d.company_id IS NULL)
      ORDER BY d.id, s.as_of_date DESC, s.revision_no DESC, s.refreshed_at DESC`,
    { replacements: { companyId }, transaction }
  );
  return rows;
}

/** Todas as métricas CRITICAL com snapshot e a freshness de cada uma agora (FRESH, STALE, EXPIRED ou UNKNOWN): [{ metricCode, domain, state, ageMinutes, ... }]. */
async function collectCriticalFreshness(scope, transaction, { now = clock.now() } = {}) {
  const params = await readFreshnessParams(scope, transaction);
  const out = [];
  for (const row of await latestSnapshots(scope.companyId, transaction)) {
    const freshness = computeFreshness({
      asOfDate: row.asOfDate, sourceSnapshotAt: row.sourceSnapshotAt, refreshedAt: row.refreshedAt,
      maxStalenessMinutes: maxStalenessOf(row.refreshPolicy, row.domain, params), factor: params.factor, now, futureToleranceMinutes: params.futureToleranceMinutes,
    });
    out.push({
      type: EVENT_TYPE, companyId: scope.companyId, groupId: scope.groupId || null, metricCode: row.metricCode, metricName: row.name, domain: row.domain,
      snapshotId: row.snapshotId, state: freshness.state, ageMinutes: freshness.ageMinutes, maxStalenessMinutes: freshness.maxStalenessMinutes,
      sourceSnapshotAt: freshness.sourceSnapshotAt, label: freshness.label,
    });
  }
  return out;
}

const isStale = (item) => item.state === STATES.STALE || item.state === STATES.EXPIRED;

/** Métricas CRITICAL com freshness STALE ou EXPIRED agora. */
async function collectCriticalStaleness(scope, transaction, options = {}) {
  return (await collectCriticalFreshness(scope, transaction, options)).filter(isStale);
}

/** Publica o alerta técnico de UMA métrica crítica vencida (log estruturado e assinantes). */
function publishStaleness(item) {
  logger.warn({ event: EVENT_TYPE, ...item }, '[analytics] métrica crítica com dado desatualizado');
  for (const fn of [...listeners]) {
    try {
      fn(item);
    } catch (err) {
      logger.error({ event: 'analytics.freshness.listener_failed', err }, '[analytics] assinante do alerta de freshness falhou');
    }
  }
}

/** Publica o alerta técnico de cada métrica crítica vencida e devolve a lista. */
async function signalCriticalStaleness(scope, transaction, options = {}) {
  const items = await collectCriticalStaleness(scope, transaction, options);
  items.forEach(publishStaleness);
  return items;
}

module.exports = { EVENT_TYPE, onFreshnessStale, collectCriticalFreshness, collectCriticalStaleness, publishStaleness, signalCriticalStaleness };
