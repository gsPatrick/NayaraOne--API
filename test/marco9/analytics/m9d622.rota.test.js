'use strict';

// M9-D622 — GET /v1/analytics/metrics/<código> dos três KPIs pela rota real: valor, unidade, status, versão, frescor, sourceRefs e componentes, e as recusas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const ledger = require('../_helpers/m9d615Ledger');
const sc = require('../_helpers/m9d622Scenario');
const oracle = require('../_helpers/m9d622Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const readModels = require('../../../src/features/analytics/read-models');
const registry = require('../_helpers/finRegistryRestore');
const { materializeFinanceKpis } = require('../../../src/features/analytics/metrics/kpis');

const NOW = new Date('2026-10-28T15:00:00Z');
const AS_OF = '2026-10-28';
const READ = ['analytics:read', 'finance:read'];
const CODES = ['fin.overdue_receivables', 'fin.delinquency_rate', 'fin.breathing_need'];
const same = (a, b) => assert.equal(money.cmp(a, b), 0, `${a} x ${b}`);
let env;
let src;
let registryBefore;
let registryBeforeB;
before(async () => {
  env = await http.setup();
  registryBefore = await registry.captureRegistry(env.admin, env.tenantA.companyId);
  registryBeforeB = await registry.captureRegistry(env.admin, env.tenantB.companyId);
  src = { admin: env.admin, created: [] };
  // A recebe a inadimplência (valor e taxa) e B a necessidade para respirar: o caixa livre de uma não pode misturar com o cenário da outra
  await sc.seedOverdue(src, env.tenantA);
  await sc.seedBreathing(src, env.tenantB);
  for (const t of [env.tenantA, env.tenantB]) {
    await http.inTx(t, { commit: true }, (tx) => readModels.applyEvent(
      { id: ledger.uuid(), eventType: 'finance.entry.created', companyId: t.companyId, groupId: t.groupId, aggregateId: ledger.uuid(), payloadJson: { id: ledger.uuid() }, occurredAt: NOW, retryCount: 0 }, tx, { now: NOW }));
    await http.inTx(t, { commit: true }, (tx) => materializeFinanceKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
  }
});
after(async () => {
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const table of ['financial_entries', 'commission_installments']) {
      const list = src.created.filter((r) => r.table === table).map((r) => r.id);
      if (list.length) await env.admin.query(`DELETE FROM finance.${table} WHERE id IN (:list)`, { replacements: { list }, transaction });
    }
    await registry.restoreRegistry(env.admin, transaction, env.tenantA.companyId, registryBefore);
    await registry.restoreRegistry(env.admin, transaction, env.tenantB.companyId, registryBeforeB);
    await env.admin.query("DELETE FROM analytics.rm_finance_health WHERE company_id IN (:a, :b) AND as_of_date = '2026-10-28'", { replacements: { a: env.tenantA.companyId, b: env.tenantB.companyId }, transaction });
  });
  await http.teardown(env);
});

const get = (code, { perms = READ, tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });
const shape = (d, code, unit, nature) => {
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode, d.valueNature], [unit, 'OK', 1, code, nature]);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.ok(Array.isArray(d.sourceRefs) && d.sourceRefs.length >= 1);
};

test('m9d622 GET /analytics/metrics/fin.overdue_receivables devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('fin.overdue_receivables');
  assert.equal(res.status, 200);
  const d = res.body.data;
  same(d.value, (await oracle.delinquencyFromSource(env, env.tenantA, AS_OF)).total);
  same(d.value, '25000.00');
  shape(d, 'fin.overdue_receivables', 'BRL', 'ACTUAL');
  assert.equal(d.sourceRefs[0].table, 'finance.financial_entries');
  assert.equal(d.sourceRefs[0].count, 3);
  assert.equal(d.drilldown.enabled, true);
  assert.equal(d.owner, 'Diretoria Financeira (papel financeiro-gestor)');
});

test('m9d622 GET /analytics/metrics/fin.delinquency_rate devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('fin.delinquency_rate')).body.data;
  const want = await oracle.delinquencyFromSource(env, env.tenantA, AS_OF);
  same(d.value, want.rate);
  shape(d, 'fin.delinquency_rate', 'PERCENT', 'ACTUAL');
  assert.equal(d.sourceRefs[0].table, 'finance.financial_entries');
  assert.match(d.formatted, /%/);
});

test('m9d622 GET /analytics/metrics/fin.breathing_need devolve valor, unidade, status, versão, frescor, sourceRefs e components[] com os sourceRefs de cada um', async () => {
  const d = (await get('fin.breathing_need', { tenant: 'B' })).body.data;
  const want = await oracle.breathingFromSource(env, env.tenantB, AS_OF);
  same(d.value, want.need);
  same(d.value, '13500.00');
  shape(d, 'fin.breathing_need', 'BRL', 'PROJECTED');
  assert.deepEqual(d.components.map((c) => c.metricCode), ['fin.overdue_payables', 'fin.payables_30d', 'fin.commissions_unlinked_30d', 'fin.free_cash']);
  for (const c of d.components) {
    assert.equal(c.status, 'OK');
    assert.ok(c.sourceRefs.length >= 1 && c.sourceRefs.every((r) => r.component === c.metricCode && r.filterHash), `${c.metricCode} traz os seus sourceRefs`);
  }
});

test('m9d622 isolamento: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  for (const code of CODES) {
    const res = await get(code, { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    const asB = await get(code, { tenant: 'B', query: `asOf=${AS_OF}&companyId=${env.tenantA.companyId}` });
    assert.equal(asB.status, 404, 'a empresa A pedida pela B não existe para ela');
    assert.doesNotMatch(JSON.stringify(asB.body), /25000|13500/);
  }
  assert.doesNotMatch(JSON.stringify((await get('fin.overdue_receivables', { tenant: 'B' })).body), /25000/, 'o valor da A não aparece na B');
});

test('m9d622 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('fin.overdue_receivables', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('fin.overdue_receivables_x');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('fin.breathing_need', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});
