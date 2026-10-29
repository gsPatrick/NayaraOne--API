'use strict';

/**
 * M9-D609 (3.3) — snapshot diário dos KPIs: "como estava naquele dia". Uma passada por empresa grava, para cada data-base pendente (D-1 e, em
 * catch-up, os dias perdidos), um snapshot de cada métrica PUBLISHED pelo provedor registrado dela (snapshots.providers), com a versão vigente
 * na data, o hash do cálculo e o sourceRefs. Imutável e idempotente: reexecutar não duplica nem altera o que existe; dois jobs simultâneos
 * disputam a linha do dia em snapshot_job_runs e o segundo ignora. Cada métrica grava em transação própria: a falha de uma gera
 * `analytics.snapshot.failed` e não impede as outras (o dia fica PARTIAL e é refeito na passada seguinte). Relógio injetável.
 */
const { sequelize } = require('../../../models');
const clock = require('./clock');
const { inCompany } = require('../companyTx');
const { pendingDays, minutesOfDaySaoPaulo } = require('./snapshots.catchup');
const { addDays } = require('./period.dates');
const { readSnapshotParams } = require('./snapshots.settings');
const { listSnapshotProviders, providerFor } = require('./snapshots.providers');
const runs = require('./snapshots.runs');
const { writeMetricSnapshots } = require('./snapshots.write');
const { emitSnapshotFailed } = require('./snapshots.events');

async function publishedMetrics(transaction) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT ON (d.metric_code) d.id AS "metricId", d.metric_code AS "metricCode"
       FROM analytics.metric_definitions d
      WHERE d.status = 'PUBLISHED' AND d.current_version_id IS NOT NULL AND d.group_scoped = false
      ORDER BY d.metric_code, (d.company_id IS NULL)`,
    { transaction }
  );
  return rows;
}

const failure = (scope, asOfDate, metricCode, err) => emitSnapshotFailed({
  companyId: scope.companyId, groupId: scope.groupId, metricCode, asOfDate, errorCode: err.code || 'ANALYTICS_SNAPSHOT_FAILED', message: err.message,
});

/** Constrói os valores do dia de cada provedor que atende alguma métrica publicada; erro do provedor vira falha das métricas dele. */
async function buildEntries(scope, asOfDate, metrics, counts) {
  const byProvider = new Map();
  for (const m of metrics) {
    const provider = providerFor(m.metricCode);
    if (!provider) { counts.withoutProvider += 1; continue; }
    byProvider.set(provider, [...(byProvider.get(provider) || []), m]);
  }
  const entries = new Map();
  for (const [provider, list] of byProvider) {
    try {
      const built = await inCompany(scope, (t) => sequelize.transaction({ transaction: t }, (sp) => provider.build(scope, asOfDate, sp)));
      for (const e of built) entries.set(e.code, e);
    } catch (err) {
      for (const m of list) { counts.failed += 1; failure(scope, asOfDate, m.metricCode, err); }
      for (const m of list) entries.set(m.metricCode, { failed: true });
    }
  }
  return entries;
}

async function snapshotDay(scope, asOfDate, capturedLate, now) {
  const row = await inCompany(scope, (t) => runs.claimDay({ ...scope, asOfDate, capturedLate, now }, t));
  if (!row) return { asOfDate, claimed: false };
  const counts = { total: 0, written: 0, existing: 0, withoutProvider: 0, withoutSource: 0, failed: 0 };
  const metrics = await inCompany(scope, (t) => publishedMetrics(t));
  counts.total = metrics.length;
  const entries = await buildEntries(scope, asOfDate, metrics, counts);
  for (const m of metrics) {
    if (!providerFor(m.metricCode)) continue;
    const entry = entries.get(m.metricCode);
    if (entry && entry.failed) continue;
    if (!entry || !entry.inputs || !entry.inputs.length) { counts.withoutSource += 1; continue; }
    try {
      const r = await inCompany(scope, (t) => writeMetricSnapshots({ entry, metricId: m.metricId, asOfDate, capturedLate }, t));
      counts.written += r.written;
      counts.existing += r.existing;
    } catch (err) {
      counts.failed += 1;
      failure(scope, asOfDate, m.metricCode, err);
    }
  }
  const closed = await inCompany(scope, (t) => runs.finishDay(row.id, counts, now, t));
  return { asOfDate, claimed: true, status: closed.status, capturedLate, counts };
}

/**
 * Uma passada da empresa. Só roda a partir da hora configurada (`analytics.snapshot.hora_execucao`, padrão 00:30 de São Paulo), salvo
 * `ignoreSchedule`. Devolve { ran, days: [resultado por data-base] }.
 */
async function runDailySnapshots(scope, { now = clock.now(), ignoreSchedule = false } = {}) {
  const params = await inCompany(scope, (t) => readSnapshotParams(scope, t));
  if (!ignoreSchedule && minutesOfDaySaoPaulo(now) < params.atMinutes) return { ran: false, reason: 'BEFORE_SCHEDULE', days: [] };
  const today = clock.businessToday(now);
  const yesterday = addDays(today, -1);
  const history = await inCompany(scope, (t) => runs.listRuns({ fromDate: addDays(yesterday, -(params.maxBackfillDays + 366)), toDate: yesterday }, t));
  const { days, late } = pendingDays({ today, runs: history, maxBackfillDays: params.maxBackfillDays });
  const results = [];
  for (const asOfDate of days) results.push(await snapshotDay(scope, asOfDate, late, now));
  return { ran: true, days: results, listProviders: listSnapshotProviders().map((p) => p.name) };
}

module.exports = { runDailySnapshots, snapshotDay };
