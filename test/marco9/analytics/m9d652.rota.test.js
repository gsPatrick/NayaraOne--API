'use strict';

// M9-D652 — GET /v1/analytics/metrics/<código> dos três KPIs pela rota real (valor, unidade, status, versão, frescor e sourceRefs), as recusas,
// o isolamento entre empresas e o replay do mesmo evento.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d652Env');
const sc = require('../_helpers/m9d652Scenario');
const httpEnv = require('../_helpers/m9d652Http');
const asserts = require('../_helpers/readModelAsserts');
const oracle = require('../_helpers/m9d652Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const READ = ['analytics:read', 'construction:read']; // M9-D702: a rota de métrica confere também a permissão do domínio (M9-D700)
const CODES = ['obra.waste', 'obra.postwork_cost', 'obra.recurrence'];
let env;
let srv;
let waste;
let post;
let p1;
before(async () => {
  env = await e.setup();
  srv = await httpEnv.start(env);
  p1 = await sc.project(env, env.cX);
  waste = await sc.seedWaste(env, env.cX, p1);
  post = await sc.seedPostwork(env, env.cX, p1);
  await sc.nonconformity(env, env.cX, p1, sc.at('2026-10-01'), { cause_code: 'infiltracao', team_label: 'Equipe B' });
  await sc.nonconformity(env, env.cX, p1, sc.at('2026-10-02'), { cause_code: 'infiltracao', team_label: 'Equipe B' });
  await sc.refreshProject(env.cX, p1, { movements: [waste.ids[0]], cases: [post.c1, post.c2], contract: post.contract });
  await e.run(env.cX, 'obra');
});
after(async () => { await srv.stop(); await e.teardown(env); });

const get = (code, { perms = READ, tenant = 'X', query = `asOf=${e.AS_OF}` } = {}) => srv.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });
const shape = (d, code, unit) => {
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode, d.valueNature], [unit, 'OK', 1, code, 'ACTUAL']);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === e.AS_OF);
  assert.ok(Array.isArray(d.sourceRefs) && d.sourceRefs.length >= 1);
};

test('m9d652 GET /analytics/metrics/obra.waste devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('obra.waste');
  assert.equal(res.status, 200);
  assert.equal(money.cmp(res.body.data.value, '14000.00'), 0);
  shape(res.body.data, 'obra.waste', 'BRL');
  assert.equal(res.body.data.sourceRefs[0].table, 'inventory.inventory_movements');
  assert.equal(res.body.data.sourceRefs[0].count, 2);
});

test('m9d652 GET /analytics/metrics/obra.postwork_cost devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('obra.postwork_cost');
  assert.equal(money.cmp(res.body.data.value, '38500.00'), 0);
  shape(res.body.data, 'obra.postwork_cost', 'BRL');
  assert.equal(res.body.data.sourceRefs[0].table, 'construction.warranty_actions');
});

test('m9d652 GET /analytics/metrics/obra.recurrence devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('obra.recurrence');
  const want = await oracle.recurrence(env, env.cX, e.AS_OF);
  assert.equal(want.count, 3, 'infiltração (2), equipe B (3: duas não conformidades e um caso) e equipe A (2 casos)');
  assert.equal(money.cmp(res.body.data.value, String(want.count)), 0);
  shape(res.body.data, 'obra.recurrence', 'COUNT');
});

test('m9d652 isolamento entre empresas no KPI', async () => {
  for (const code of CODES) {
    const res = await get(code, { tenant: 'B', query: `asOf=${e.AS_OF}&companyId=${env.cX.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    const asB = await get(code, { tenant: 'B' });
    assert.notEqual(asB.status, 200, 'a empresa B não tem o indicador nem o snapshot da X');
    assert.doesNotMatch(JSON.stringify(asB.body), /14000|38500/);
    const asY = await get(code, { tenant: 'Y' });
    assert.doesNotMatch(JSON.stringify(asY.body), /14000|38500/, 'outra empresa do grupo também não vê o valor');
  }
});

test('m9d652 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('obra.waste', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('obra.waste_x');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('obra.waste', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});

test('m9d652 replay do mesmo evento não altera o valor', async () => {
  const t = env.cX;
  const events = [['inventory.movement.recorded', { id: waste.ids[0] }, 'rm_project_waste'], ['warranty.case.opened', { id: post.c1 }, 'rm_postwork_cost'], ['nonconformity.opened', { projectId: p1 }, 'rm_project_occurrences']];
  for (const [type, payload, model] of events) {
    const ev = e.event(t, type, payload);
    const readRow = async () => {
      await e.run(t, 'obra');
      const kpis = await Promise.all(CODES.map((c) => e.readKpi(t, c)));
      return { rows: await e.rowsOf(env, model, t), values: kpis.map((k) => [k.value, k.status]) };
    };
    await e.inTx(t, { commit: true }, (tx) => e.readModels.applyEvent({ ...ev, id: e.uuid() }, tx, { now: e.NOW })); // a primeira aplicação já refresca a linha
    await asserts.assertReplayIdempotent({ applyEvent: () => e.inTx(t, { commit: true }, (tx) => e.readModels.applyEvent(ev, tx, { now: e.NOW })), readRow });
  }
});
