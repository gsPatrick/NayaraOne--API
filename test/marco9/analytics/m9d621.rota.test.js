'use strict';

// M9-D621 — GET /v1/analytics/metrics/<código> dos seis KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs, e as recusas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const ledger = require('../_helpers/m9d615Ledger');
const scenario = require('../_helpers/m9d621Scenario');
const { windowFromSource } = require('../_helpers/m9d621Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const readModels = require('../../../src/features/analytics/read-models');
const { materializeFinanceKpis } = require('../../../src/features/analytics/metrics/kpis');

const NOW = new Date('2026-10-28T15:00:00Z');
const AS_OF = '2026-10-28';
const READ = ['analytics:read'];
let env;
let src;
before(async () => {
  env = await http.setup();
  src = { admin: env.admin, created: [] };
  const t = env.tenantA;
  await scenario.seed(src, t);
  const event = { id: ledger.uuid(), eventType: 'finance.entry.created', companyId: t.companyId, groupId: t.groupId, aggregateId: ledger.uuid(), payloadJson: { id: ledger.uuid() }, occurredAt: NOW, retryCount: 0 };
  await http.inTx(t, { commit: true }, (tx) => readModels.applyEvent(event, tx, { now: NOW }));
  await http.inTx(t, { commit: true }, (tx) => materializeFinanceKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
});
after(async () => {
  const ids = { c: env.tenantA.companyId, codes: scenario.CODES };
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await env.admin.query('DELETE FROM finance.financial_entries WHERE id IN (:list)', { replacements: { list: src.created.map((r) => r.id) }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id = :c AND metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN (:codes))', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN (:codes))', { replacements: ids, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c AND metric_code IN (:codes)', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN (:codes)', { replacements: ids, transaction });
    await env.admin.query("DELETE FROM analytics.rm_finance_health WHERE company_id = :c AND as_of_date = '2026-10-28'", { replacements: ids, transaction });
  });
  await http.teardown(env);
});

const get = (code, { perms = READ, tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });

for (const code of scenario.CODES) {
  test(`m9d621 GET /analytics/metrics/${code} devolve valor, unidade, status, versão, frescor e sourceRefs`, async () => {
    const res = await get(code);
    assert.equal(res.status, 200);
    const d = res.body.data;
    const want = await windowFromSource(env, env.tenantA, { nature: code.startsWith('fin.payables') ? 'PAYABLE' : 'RECEIVABLE', asOf: AS_OF, days: Number(/_(\d+)d$/.exec(code)[1]) });
    assert.equal(money.cmp(d.value, want.value), 0);
    assert.equal(money.cmp(d.value, scenario.EXPECTED[code]), 0);
    assert.deepEqual([d.unit, d.status, d.version, d.metricCode, d.valueNature], ['BRL', 'OK', 1, code, 'PLANNED']);
    assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
    assert.equal(d.sourceRefs[0].table, 'finance.financial_entries');
    assert.equal(d.sourceRefs[0].count, want.count);
  });
}

test('m9d621 isolamento: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  const res = await get('fin.payables_7d', { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
  assert.equal(res.status, 404);
  assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
  const asB = await get('fin.payables_7d', { tenant: 'B' });
  assert.notEqual(asB.status, 200, 'a empresa B não tem o indicador publicado nem o snapshot da A');
  assert.doesNotMatch(JSON.stringify(asB.body), /15000\.00/);
});

test('m9d621 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('fin.payables_7d', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('fin.payables_999d');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('fin.payables_7d', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});
