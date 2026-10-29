'use strict';

// M9-D623 — GET /v1/analytics/metrics/<código> dos quatro KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs, e as recusas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const ledger = require('../_helpers/m9d615Ledger');
const sc = require('../_helpers/m9d623Scenario');
const oracle = require('../_helpers/m9d623Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const readModels = require('../../../src/features/analytics/read-models');
const registry = require('../_helpers/finRegistryRestore');
const { materializeFinanceKpis } = require('../../../src/features/analytics/metrics/kpis');

const NOW = new Date('2026-10-28T15:00:00Z');
const AS_OF = '2026-10-28';
const READ = ['analytics:read', 'finance:read'];
const CODES = ['fin.sector_margin', 'fin.commissions_provisioned', 'fin.commissions_paid', 'fin.owner_repasses_pending'];
const same = (a, b) => assert.equal(money.cmp(a, b), 0, `${a} x ${b}`);
let env;
let src;
let registryBefore;
before(async () => {
  env = await http.setup();
  registryBefore = await registry.captureRegistry(env.admin, env.tenantA.companyId);
  src = { admin: env.admin, created: [] };
  const t = env.tenantA;
  const [[{ id: broker }]] = await env.admin.query("SELECT id FROM core.users WHERE status = 'ACTIVE' AND deleted_at IS NULL ORDER BY created_at LIMIT 1");
  await sc.seedMargin(src, t);
  await sc.seedCommissions(src, t, broker);
  await sc.seedRepasses(src, t);
  const apply = (payload, eventType = 'finance.entry.created') => http.inTx(t, { commit: true }, (tx) => readModels.applyEvent(
    { id: ledger.uuid(), eventType, companyId: t.companyId, groupId: t.groupId, aggregateId: ledger.uuid(), payloadJson: { id: ledger.uuid(), ...payload }, occurredAt: NOW, retryCount: 0 }, tx, { now: NOW }));
  for (const resultCenterId of [sc.CENTER.locacao, sc.CENTER.vendas]) await apply({ resultCenterId, competenceMonth: sc.MONTH });
  await apply({}, 'finance.owner_repasse.created');
  await http.inTx(t, { commit: true }, (tx) => materializeFinanceKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
});
after(async () => {
  const ids = { c: env.tenantA.companyId, codes: CODES };
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const table of ['financial_entries', 'commission_installments', 'commissions', 'owner_repasses']) {
      const list = src.created.filter((r) => r.table === table).map((r) => r.id);
      if (list.length) await env.admin.query(`DELETE FROM finance.${table} WHERE id IN (:list)`, { replacements: { list }, transaction });
    }
    await registry.restoreRegistry(env.admin, transaction, env.tenantA.companyId, registryBefore);
    await env.admin.query("DELETE FROM analytics.rm_finance_health WHERE company_id = :c AND as_of_date = '2026-10-28'", { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.rm_finance_sector_margin WHERE company_id = :c', { replacements: ids, transaction });
  });
  await http.teardown(env);
});

const get = (code, { perms = READ, tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });
const shape = (d, code, unit, nature) => {
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode, d.valueNature], [unit, 'OK', 1, code, nature]);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.ok(Array.isArray(d.sourceRefs) && d.sourceRefs.length >= 1);
};

test('m9d623 GET /analytics/metrics/fin.sector_margin devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('fin.sector_margin')).body.data;
  same(d.value, (await oracle.marginFromSource(env, env.tenantA, sc.MONTH)).total);
  same(d.value, '66500.00');
  shape(d, 'fin.sector_margin', 'BRL', 'ACTUAL');
  assert.equal(d.sourceRefs[0].table, 'finance.financial_entries');
});

test('m9d623 GET /analytics/metrics/fin.commissions_provisioned devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('fin.commissions_provisioned')).body.data;
  same(d.value, '21000.00');
  shape(d, 'fin.commissions_provisioned', 'BRL', 'PLANNED');
  assert.equal(d.sourceRefs[0].table, 'finance.commission_installments');
});

test('m9d623 GET /analytics/metrics/fin.commissions_paid devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('fin.commissions_paid')).body.data;
  same(d.value, '18000.00');
  shape(d, 'fin.commissions_paid', 'BRL', 'ACTUAL');
});

test('m9d623 GET /analytics/metrics/fin.owner_repasses_pending devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('fin.owner_repasses_pending')).body.data;
  same(d.value, '54000.00');
  shape(d, 'fin.owner_repasses_pending', 'BRL', 'ACTUAL');
  assert.equal(d.sourceRefs[0].table, 'finance.owner_repasses');
  assert.equal(d.sourceRefs[0].count, 2);
});

test('m9d623 isolamento: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  for (const code of CODES) {
    const res = await get(code, { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    const asB = await get(code, { tenant: 'B' });
    assert.notEqual(asB.status, 200, 'a empresa B não tem o indicador nem o snapshot da A');
    assert.doesNotMatch(JSON.stringify(asB.body), /54000|21000|66500/);
  }
});

test('m9d623 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('fin.sector_margin', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('fin.sector_margin_x');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('fin.sector_margin', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});
