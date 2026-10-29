'use strict';

// M9-D609 (3.3 e 3.4) — o snapshot diário dos KPIs financeiros pelo caminho real (rm_finance_health -> fórmula -> buildSourceRefs) e a rota
// GET /analytics/metrics/:code?asOf= com freshness e historical. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const ledger = require('../_helpers/m9d615Ledger');
const readModels = require('../../../src/features/analytics/read-models');
const clock = require('../../../src/features/analytics/metrics/clock');
const { materializeFinanceKpis } = require('../../../src/features/analytics/metrics/kpis');
const { runDailySnapshots } = require('../../../src/features/analytics/metrics/snapshots.service');

const NOW = new Date('2026-10-28T15:00:00Z');
const AS_OF = '2026-10-28';
const CODES = ['fin.reconciliations_pending', 'fin.anomalies_open'];
const dayAt = (n) => new Date(Date.UTC(2026, 9, 28 + n, 15)).toISOString();
let env;
let src;
let t;
const snaps = async () => (await env.admin.query(
  `SELECT d.metric_code AS code, s.dimension_key, s.revision_no, s.captured_late, s.calc_hash, s.source_refs, s.value_numeric::text AS v, s.metric_version_id
     FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id
    WHERE s.company_id = :c AND d.metric_code IN (:codes) AND s.as_of_date = :d ORDER BY d.metric_code, s.dimension_key`, { replacements: { c: t.companyId, codes: CODES, d: AS_OF } }))[0];

before(async () => {
  env = await http.setup();
  t = env.tenantA;
  src = { admin: env.admin, created: [] };
  clock.setClock(() => NOW);
  const account = ledger.uuid();
  await ledger.insert(src, 'bank_statement_imports', t, { bank_account_id: account, period_start: '2026-09-01', period_end: '2026-09-30', created_at: dayAt(-1) });
  for (const [amount, offset] of [['120.10', -1], ['-80.05', -4]]) await ledger.insert(src, 'bank_transactions', t, { bank_account_id: account, amount, transaction_date: dayAt(offset), created_at: dayAt(-1) });
  const event = { id: ledger.uuid(), eventType: 'finance.reconciliation.matched', companyId: t.companyId, groupId: t.groupId, aggregateId: ledger.uuid(), payloadJson: {}, occurredAt: NOW, retryCount: 0 };
  await http.inTx(t, { commit: true }, (tx) => readModels.applyEvent(event, tx, { now: NOW }));
  await http.inTx(t, { commit: true }, (tx) => materializeFinanceKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
});
after(async () => {
  clock.resetClock();
  const ids = { c: t.companyId };
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const [table, list] of Object.entries(src.created.reduce((m, r) => ({ ...m, [r.table]: [...(m[r.table] || []), r.id] }), {}))) {
      await env.admin.query(`DELETE FROM finance.${table} WHERE id IN (:list)`, { replacements: { list }, transaction });
    }
    await env.admin.query('DELETE FROM analytics.snapshot_job_runs WHERE company_id = :c', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id = :c', { replacements: ids, transaction });
    await env.admin.query("DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN ('fin.reconciliations_pending', 'fin.anomalies_open'))", { replacements: ids, transaction });
    await env.admin.query("UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c AND metric_code IN ('fin.reconciliations_pending', 'fin.anomalies_open')", { replacements: ids, transaction });
    await env.admin.query("DELETE FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN ('fin.reconciliations_pending', 'fin.anomalies_open')", { replacements: ids, transaction });
    await env.admin.query("DELETE FROM analytics.rm_finance_health WHERE company_id = :c AND as_of_date = '2026-10-28'", { replacements: ids, transaction });
  });
  await http.teardown(env);
});

test('m9d609 snapshot diário dos KPIs financeiros grava versão, hash e source_refs de buildSourceRefs para toda métrica publicada', async () => {
  const live = await snaps();
  assert.ok(live.length >= 2, 'o refresh já gravou os snapshots ao vivo');
  // o job em outro dia: apaga o que o refresh gravou e a passada do dia seguinte reconstrói pelo mesmo caminho
  await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id = :c AND as_of_date = :d', { replacements: { c: t.companyId, d: AS_OF } });
  const result = await runDailySnapshots({ companyId: t.companyId, groupId: t.groupId }, { now: new Date('2026-10-29T03:30:00Z') });
  const day = result.days.find((d) => d.asOfDate === AS_OF);
  assert.ok(day && day.claimed, 'D-1 processado');
  assert.equal(day.counts.failed, 0);
  const rows = await snaps();
  assert.deepEqual(rows.map((r) => [r.code, r.dimension_key, r.v]), live.map((r) => [r.code, r.dimension_key, r.v]), 'os mesmos números do refresh');
  for (const code of CODES) {
    const main = rows.find((r) => r.code === code && r.dimension_key === '');
    assert.ok(main, `${code} tem o valor principal`);
    assert.match(main.calc_hash, /^[0-9a-f]{64}$/);
    assert.ok(main.metric_version_id);
    assert.ok(main.source_refs.length >= 1, 'source_refs montado por buildSourceRefs');
    for (const ref of main.source_refs) {
      assert.match(ref.filterHash, /^[0-9a-f]{64}$/, 'filterHash SHA-256');
      assert.ok(ref.filterSignature && ref.filterSignature.length >= 16, 'filterHash assinado (HMAC)');
      assert.ok(Number.isInteger(ref.count), 'count');
      assert.ok(ref.table, 'a tabela de origem');
    }
    assert.equal(main.captured_late, false);
  }
  const reconciliations = rows.find((r) => r.code === 'fin.reconciliations_pending' && r.dimension_key === '');
  assert.equal(reconciliations.source_refs[0].count >= 0, true);
});

test('m9d609 rota de métrica por data: histórica, futura e inexistente', async () => {
  clock.setClock(() => new Date('2026-10-29T15:00:00Z')); // hoje é 29/10: 28/10 é dia passado
  const ok = await env.call('GET', `/analytics/metrics/fin.reconciliations_pending?asOf=${AS_OF}`, { perms: ['analytics:read', 'finance:read'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.historical, true, 'asOf anterior a hoje');
  assert.equal(ok.body.data.version, 1);
  assert.ok(ok.body.data.freshness && ok.body.data.freshness.state, 'bloco de freshness');
  assert.ok(ok.body.data.freshness.sourceSnapshotAt);
  assert.equal(ok.body.data.freshness.historical, true);
  const future = await env.call('GET', '/analytics/metrics/fin.reconciliations_pending?asOf=2999-01-01', { perms: ['analytics:read', 'finance:read'] });
  assert.equal(future.status, 400);
  assert.equal(future.body.error?.code || future.body.code, 'ANALYTICS_AS_OF_FUTURE');
  const none = await env.call('GET', '/analytics/metrics/fin.reconciliations_pending?asOf=2020-01-01', { perms: ['analytics:read', 'finance:read'] });
  assert.equal(none.status, 404);
  assert.equal(none.body.error?.code || none.body.code, 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE');
  const other = await env.call('GET', `/analytics/metrics/fin.reconciliations_pending?asOf=${AS_OF}`, { perms: ['analytics:read', 'finance:read'], tenant: 'B' });
  assert.equal(other.status, 404, 'a empresa B não enxerga o snapshot da A');
});
