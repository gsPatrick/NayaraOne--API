'use strict';

// M9-D653 — GET /v1/analytics/metrics/<código> dos quatro KPIs pela rota real (valor, unidade, status, versão, frescor e sourceRefs), as recusas,
// o isolamento entre empresas e o replay do mesmo evento.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d652Env');
const sc = require('../_helpers/m9d653Scenario');
const httpEnv = require('../_helpers/m9d652Http');
const asserts = require('../_helpers/readModelAsserts');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const READ = ['analytics:read'];
const CODES = ['inv.stock_value', 'inv.below_minimum', 'inv.losses', 'inv.tools_overdue'];
let env;
let srv;
before(async () => {
  env = await e.setup();
  srv = await httpEnv.start(env);
  const stock = await sc.seedStock(env, env.cX);
  await sc.seedLosses(env, env.cX, stock.a);
  await sc.seedTools(env, env.cX);
  await sc.refresh(env.cX);
  await e.run(env.cX, 'inv');
});
after(async () => { await srv.stop(); await e.teardown(env); });

const get = (code, { perms = READ, tenant = 'X', query = `asOf=${e.AS_OF}` } = {}) => srv.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });
const shape = (d, code, unit) => {
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode, d.valueNature], [unit, 'OK', 1, code, 'ACTUAL']);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === e.AS_OF);
  assert.ok(Array.isArray(d.sourceRefs) && d.sourceRefs.length >= 1);
};

test('m9d653 GET /analytics/metrics/inv.stock_value devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('inv.stock_value');
  assert.equal(res.status, 200);
  assert.equal(money.cmp(res.body.data.value, '900.00'), 0);
  shape(res.body.data, 'inv.stock_value', 'BRL');
  assert.equal(res.body.data.sourceRefs[0].table, 'inventory.stock_balances');
});

test('m9d653 GET /analytics/metrics/inv.below_minimum devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('inv.below_minimum');
  assert.equal(money.cmp(res.body.data.value, '2'), 0);
  shape(res.body.data, 'inv.below_minimum', 'COUNT');
  assert.equal(res.body.data.sourceRefs[0].count, 2);
});

test('m9d653 GET /analytics/metrics/inv.losses devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('inv.losses');
  assert.equal(money.cmp(res.body.data.value, '2450.00'), 0);
  shape(res.body.data, 'inv.losses', 'BRL');
  assert.equal(res.body.data.sourceRefs[0].table, 'inventory.loss_cases');
});

test('m9d653 GET /analytics/metrics/inv.tools_overdue devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('inv.tools_overdue');
  assert.equal(money.cmp(res.body.data.value, '2'), 0);
  shape(res.body.data, 'inv.tools_overdue', 'COUNT');
  assert.equal(res.body.data.sourceRefs[0].table, 'inventory.tool_loans');
});

test('m9d653 isolamento entre empresas no KPI', async () => {
  for (const code of CODES) {
    const res = await get(code, { tenant: 'B', query: `asOf=${e.AS_OF}&companyId=${env.cX.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    const asB = await get(code, { tenant: 'B' });
    assert.notEqual(asB.status, 200, 'a empresa B não tem o indicador nem o snapshot da X');
    assert.doesNotMatch(JSON.stringify(asB.body), /"value":"(900|2450)/);
    assert.doesNotMatch(JSON.stringify(await get(code, { tenant: 'Y' })), /"value":"(900|2450)/, 'outra empresa do grupo também não vê o valor');
  }
});

test('m9d653 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('inv.losses', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('inv.losses_x');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('inv.losses', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});

test('m9d653 replay do mesmo evento não altera o valor', async () => {
  const t = env.cX;
  for (const [type, model] of [['inventory.stock.low', 'rm_inventory_health'], ['tool.loan.created', 'rm_tool_assets']]) {
    const ev = e.event(t, type, {});
    const readRow = async () => {
      await e.run(t, 'inv');
      const kpis = await Promise.all(CODES.map((c) => e.readKpi(t, c)));
      return { rows: await e.rowsOf(env, model, t), values: kpis.map((k) => [k.value, k.status]) };
    };
    await e.inTx(t, { commit: true }, (tx) => e.readModels.applyEvent({ ...ev, id: e.uuid() }, tx, { now: e.NOW }));
    await asserts.assertReplayIdempotent({ applyEvent: () => e.inTx(t, { commit: true }, (tx) => e.readModels.applyEvent(ev, tx, { now: e.NOW })), readRow });
  }
});
