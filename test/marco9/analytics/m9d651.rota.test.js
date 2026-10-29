'use strict';

// M9-D651 — GET /v1/analytics/metrics/<código> dos três KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs, e as recusas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const bi = require('../_helpers/obraKpiEnv');
const scenario = require('../_helpers/m9d651Scenario');
const oracle = require('../_helpers/m9d651Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const clock = require('../../../src/features/analytics/metrics/clock');

const READ = ['analytics:read'];
const UNITS = { 'obra.delays': 'COUNT', 'obra.measurements': 'BRL', 'obra.nonconformities': 'COUNT' };
let env;
let src;
let want;
before(async () => {
  env = await http.setup();
  clock.setClock(bi.NOW);
  src = { admin: env.admin, created: [], tenantA: env.tenantA, tenantB: env.tenantB, models: bi.MODELS };
  await scenario.seedAll(src, env.tenantA);
  want = {
    'obra.delays': (await oracle.delaysFacts(src, env.tenantA, bi.AS_OF)).count,
    'obra.measurements': (await oracle.measurementsFacts(src, env.tenantA, bi.AS_OF)).measured,
    'obra.nonconformities': (await oracle.nonconformityFacts(src, env.tenantA, bi.AS_OF)).open,
  };
});
after(async () => {
  clock.resetClock();
  await new Promise((resolve) => env.server.close(resolve));
  await bi.teardown(src);
});

const get = (code, { perms = READ, tenant = 'A', query = `asOf=${bi.AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });

for (const code of Object.keys(UNITS)) {
  test(`m9d651 GET /analytics/metrics/${code} devolve valor, unidade, status, versão, frescor e sourceRefs`, async () => {
    const res = await get(code);
    assert.equal(res.status, 200);
    const d = res.body.data;
    assert.equal(money.cmp(d.value, want[code]), 0, `${code}: ${d.value} x ${want[code]}`);
    assert.deepEqual([d.unit, d.status, d.version, d.metricCode, d.valueNature], [UNITS[code], 'OK', 1, code, 'ACTUAL']);
    assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === bi.AS_OF);
    assert.ok(Array.isArray(d.sourceRefs) && d.sourceRefs[0].filterHash && d.sourceRefs[0].count >= 1);
  });
}

test('m9d651 isolamento: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  const res = await get('obra.measurements', { query: `asOf=${bi.AS_OF}&companyId=${env.tenantB.companyId}` });
  assert.equal(res.status, 404);
  assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
  const asB = await get('obra.measurements', { tenant: 'B' });
  assert.notEqual(asB.status, 200, 'a empresa B não tem o indicador publicado nem o snapshot da A');
  assert.doesNotMatch(JSON.stringify(asB.body), /220000/);
});

test('m9d651 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('obra.delays', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('obra.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('obra.delays', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});
