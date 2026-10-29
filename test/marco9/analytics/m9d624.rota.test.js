'use strict';

// M9-D624 — GET /v1/analytics/metrics/<código> dos dois KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs, e as recusas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const ledger = require('../_helpers/m9d615Ledger');
const { reconciliationsFromSource, anomaliesFromSource } = require('../_helpers/m9d624Oracle');
const readModels = require('../../../src/features/analytics/read-models');
const { materializeFinanceKpis } = require('../../../src/features/analytics/metrics/kpis');

const NOW = new Date('2026-10-28T15:00:00Z');
const AS_OF = '2026-10-28';
const READ = ['analytics:read'];
const dayAt = (n) => new Date(Date.UTC(2026, 9, 28 + n, 15)).toISOString();
let env;
let src;
before(async () => {
  env = await http.setup();
  src = { admin: env.admin, created: [] };
  const t = env.tenantA;
  const account = ledger.uuid();
  await ledger.insert(src, 'bank_statement_imports', t, { bank_account_id: account, period_start: '2026-09-01', period_end: '2026-09-30', created_at: dayAt(-1) });
  for (const [amount, offset] of [['120.10', -1], ['-80.05', -4], ['10.00', -9]]) await ledger.insert(src, 'bank_transactions', t, { bank_account_id: account, amount, transaction_date: dayAt(offset), created_at: dayAt(-1) });
  await ledger.insert(src, 'anomaly_cases', t, { case_type: 'DUPLICATE', risk_level: 'HIGH', reason: 'x', status: 'OPEN', created_at: dayAt(-2) });
  await ledger.insert(src, 'anomaly_cases', t, { case_type: 'DUPLICATE', risk_level: 'LOW', reason: 'x', status: 'OPEN', created_at: dayAt(-1) });
  const event = { id: ledger.uuid(), eventType: 'finance.reconciliation.matched', companyId: t.companyId, groupId: t.groupId, aggregateId: ledger.uuid(), payloadJson: {}, occurredAt: NOW, retryCount: 0 };
  await http.inTx(t, { commit: true }, (tx) => readModels.applyEvent(event, tx, { now: NOW }));
  await http.inTx(t, { commit: true }, (tx) => materializeFinanceKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
});
after(async () => {
  const ids = { c: env.tenantA.companyId };
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const [table, list] of Object.entries(src.created.reduce((m, r) => ({ ...m, [r.table]: [...(m[r.table] || []), r.id] }), {}))) {
      await env.admin.query(`DELETE FROM finance.${table} WHERE id IN (:list)`, { replacements: { list }, transaction });
    }
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id = :c', { replacements: ids, transaction });
    await env.admin.query("DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN ('fin.reconciliations_pending', 'fin.anomalies_open'))", { replacements: ids, transaction });
    await env.admin.query("UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c AND metric_code IN ('fin.reconciliations_pending', 'fin.anomalies_open')", { replacements: ids, transaction });
    await env.admin.query("DELETE FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN ('fin.reconciliations_pending', 'fin.anomalies_open')", { replacements: ids, transaction });
    await env.admin.query("DELETE FROM analytics.rm_finance_health WHERE company_id = :c AND as_of_date = '2026-10-28'", { replacements: ids, transaction });
  });
  await http.teardown(env);
});

const get = (code, { perms = READ, tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });

test('m9d624 GET /analytics/metrics/fin.reconciliations_pending devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('fin.reconciliations_pending');
  assert.equal(res.status, 200);
  const d = res.body.data;
  const want = await reconciliationsFromSource(env, env.tenantA, AS_OF);
  assert.equal(Number(d.value), Number(want.count));
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode], ['COUNT', 'OK', 1, 'fin.reconciliations_pending']);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.equal(d.sourceRefs[0].table, 'finance.bank_transactions');
  assert.equal(d.sourceRefs[0].count, Number(want.count), 'o sourceRefs conta as mesmas transações do valor');
  assert.equal(d.sourceRefs[0].restricted, true);
});

test('m9d624 GET /analytics/metrics/fin.anomalies_open devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('fin.anomalies_open');
  assert.equal(res.status, 200);
  const d = res.body.data;
  const want = await anomaliesFromSource(env, env.tenantA, AS_OF);
  assert.equal(Number(d.value), Number(want.total));
  assert.deepEqual([d.unit, d.status, d.version], ['COUNT', 'OK', 1]);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt);
  assert.equal(d.sourceRefs[0].table, 'finance.anomaly_cases');
  assert.equal(d.sourceRefs[0].count, Number(want.total));
});

test('m9d624 isolamento: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND', async () => {
  const res = await get('fin.reconciliations_pending', { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
  assert.equal(res.status, 404);
  assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
  const asB = await get('fin.reconciliations_pending', { tenant: 'B' });
  assert.notEqual(asB.status, 200, 'a empresa B não tem o indicador publicado nem o snapshot da A');
});

test('m9d624 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('fin.reconciliations_pending', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('fin.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('fin.reconciliations_pending', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});
