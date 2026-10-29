'use strict';

// M9-D609 (BI-013, Guia §11 e §14) — freshness calculada no servidor: FRESH, STALE, EXPIRED e nunca atualizado, regra de exibição e
// limites por domínio como parâmetro. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d609Env');
const { computeFreshness, STATES, EXPIRED_TEXT } = require('../../../src/features/analytics/metrics/freshness');

const NOW = '2026-10-29T15:00:00Z'; // 12:00 de 29/10/2026 em São Paulo
const TODAY = '2026-10-29';
const minutesAgo = (n) => new Date(new Date(NOW).getTime() - n * 60000).toISOString();
let env;
let tenant;

before(async () => {
  env = await e.setup();
  tenant = env.tenantA;
  e.at(NOW);
});
after(() => e.teardown(env));

async function metricAged(ageMinutes, extra = {}) {
  const m = await e.publish(env, tenant, extra);
  await e.snapshot(tenant, { ...m, asOfDate: TODAY, sourceSnapshotAt: minutesAgo(ageMinutes), refreshedAt: minutesAgo(Math.min(ageMinutes, 1)) });
  return m;
}

test('m9d609 freshness correta: FRESH, STALE e EXPIRED nos limites exatos', async () => {
  const cases = [[0, 'FRESH'], [59, 'FRESH'], [60, 'FRESH'], [61, 'STALE'], [239, 'STALE'], [240, 'STALE'], [241, 'EXPIRED'], [5000, 'EXPIRED']];
  for (const [age, state] of cases) {
    const f = computeFreshness({ sourceSnapshotAt: minutesAgo(age), refreshedAt: NOW, maxStalenessMinutes: 60, factor: 4, now: new Date(NOW) });
    assert.equal(f.state, state, `idade ${age} min`);
    assert.equal(f.ageMinutes, age);
  }
  assert.equal(computeFreshness({ sourceSnapshotAt: new Date(new Date(NOW).getTime() - 60 * 60000 - 59000).toISOString(), maxStalenessMinutes: 60, factor: 4, now: new Date(NOW) }).state, 'FRESH', 'minutos inteiros: 60 min e 59 s é 60');
  // pela leitura real (FINANCE, limite 60 da política da métrica): 20 min, 60 min, 61 min, 3 h e 5 h
  const expected = { 20: 'FRESH', 60: 'FRESH', 61: 'STALE', 180: 'STALE', 300: 'EXPIRED' };
  for (const [age, state] of Object.entries(expected)) {
    const m = await metricAged(Number(age));
    const r = await e.readValue(tenant, m.code, TODAY);
    assert.equal(r.freshness.state, state, `idade ${age} min`);
    assert.equal(r.freshness.ageMinutes, Number(age));
    assert.equal(r.freshness.maxStalenessMinutes, 60);
    assert.equal(r.freshness.sourceSnapshotAt.toISOString(), minutesAgo(Number(age)));
    assert.ok(r.freshness.refreshedAt, 'refreshedAt presente');
    const asOf = await e.readAsOf(tenant, m.code, TODAY);
    assert.equal(asOf.freshness.state, state, 'a leitura por data traz a mesma freshness');
  }
});

test('m9d609 STALE mostra o selo "Desatualizado há 3 h" e o status STALE, sem esconder o valor', async () => {
  const m = await metricAged(180);
  const r = await e.readValue(tenant, m.code, TODAY);
  assert.equal(r.status, 'STALE');
  assert.equal(r.freshness.label, 'Desatualizado há 3 h');
  assert.equal(r.value, '100.0000', 'o valor continua, com o selo ao lado');
  const fresh = await metricAged(20);
  const f = await e.readValue(tenant, fresh.code, TODAY);
  assert.equal(f.status, 'OK');
  assert.match(f.freshness.label, /^Atualizado às \d{2}:\d{2}$/);
  assert.equal(f.freshness.label, 'Atualizado às 11:40', 'hora de São Paulo da fonte');
});

test('m9d609 selo usa source_snapshot_at e não refreshed_at', async () => {
  // refresh recente (agora) sobre fonte lida há 3 h: continua velho
  const m = await e.publish(env, tenant);
  await e.snapshot(tenant, { ...m, asOfDate: TODAY, sourceSnapshotAt: minutesAgo(180), refreshedAt: NOW });
  const r = await e.readValue(tenant, m.code, TODAY);
  assert.equal(r.freshness.ageMinutes, 180, 'a idade vem da fonte');
  assert.equal(r.freshness.state, 'STALE');
  assert.equal(r.status, 'STALE', 'um refresh novo sobre fonte velha não maquia o dado');
  assert.equal(r.freshness.label, 'Desatualizado há 3 h');
  assert.equal(r.freshness.refreshedAt.toISOString(), new Date(NOW).toISOString(), 'refreshedAt segue informado, mas não decide');
});

test('m9d609 freshness EXPIRED devolve DEGRADED com value nulo', async () => {
  const m = await metricAged(300);
  for (const read of [e.readValue, e.readAsOf]) {
    const r = await read(tenant, m.code, TODAY);
    assert.equal(r.freshness.state, 'EXPIRED');
    assert.equal(r.status, 'DEGRADED');
    assert.equal(r.value, null, 'nunca o número');
    assert.equal(r.freshness.label, EXPIRED_TEXT);
    assert.equal(r.freshness.label, 'Dado antigo, não use para decidir');
    assert.equal(r.freshness.expiredAboveMinutes, 240);
  }
  assert.ok(!Object.values(STATES).includes('DEGRADED'), 'EXPIRED é estado de freshness, DEGRADED é status');
});

test('m9d609 read model sem atualização é INCOMPLETE', async () => {
  const m = await e.publish(env, tenant);
  await e.snapshot(tenant, { ...m, asOfDate: TODAY, sourceSnapshotAt: null, refreshedAt: NOW });
  for (const read of [e.readValue, e.readAsOf]) {
    const r = await read(tenant, m.code, TODAY);
    assert.equal(r.status, 'INCOMPLETE');
    assert.equal(r.value, null, 'sem valor enganoso');
    assert.equal(r.freshness.state, 'UNKNOWN');
    assert.equal(r.freshness.ageMinutes, null);
  }
});

test('m9d609 status pior gravado no snapshot nunca é melhorado pela freshness', async () => {
  const m = await e.publish(env, tenant);
  await e.snapshot(tenant, { ...m, asOfDate: TODAY, sourceSnapshotAt: minutesAgo(10), refreshedAt: NOW, status: 'DEGRADED' });
  const r = await e.readValue(tenant, m.code, TODAY);
  assert.equal(r.freshness.state, 'FRESH');
  assert.equal(r.status, 'DEGRADED');
});

test('m9d609 limites por domínio e o fator são parâmetros do administrador', async () => {
  const policy = await e.publish(env, tenant, { prefix: 'crm', maxStalenessMinutes: 30 });
  await e.snapshot(tenant, { ...policy, asOfDate: TODAY, sourceSnapshotAt: minutesAgo(45), refreshedAt: NOW });
  const before1 = await e.readValue(tenant, policy.code, TODAY);
  assert.equal(before1.freshness.maxStalenessMinutes, 30, 'sem parâmetro vale a política da métrica');
  assert.equal(before1.freshness.state, 'STALE');
  await e.setSetting(env, tenant, 'analytics.freshness.max_minutos.CRM', 90);
  const after1 = await e.readValue(tenant, policy.code, TODAY);
  assert.equal(after1.freshness.maxStalenessMinutes, 90, 'o parâmetro do domínio vale');
  assert.equal(after1.freshness.state, 'FRESH');
  await e.setSetting(env, tenant, 'analytics.freshness.fator_expirado', 2);
  const aged = await e.publish(env, tenant, { prefix: 'crm' });
  await e.snapshot(tenant, { ...aged, asOfDate: TODAY, sourceSnapshotAt: minutesAgo(200), refreshedAt: NOW });
  const r = await e.readValue(tenant, aged.code, TODAY);
  assert.equal(r.freshness.expiredAboveMinutes, 180, '2 x 90');
  assert.equal(r.freshness.state, 'EXPIRED');
  const other = await e.readValue(env.tenantB, policy.code, TODAY).catch((err) => err);
  assert.ok(other.statusCode === 404 || other.code, 'a outra empresa não enxerga a métrica nem o parâmetro');
});

test('m9d609 leitura de dia passado devolve o registro como foi gravado, com a freshness da época', async () => {
  const m = await e.publish(env, tenant);
  await e.snapshot(tenant, { ...m, asOfDate: '2026-10-20', sourceSnapshotAt: '2026-10-20T14:00:00Z', refreshedAt: '2026-10-20T14:10:00Z', value: '42.0000' });
  const r = await e.readAsOf(tenant, m.code, '2026-10-20');
  assert.equal(r.historical, true);
  assert.equal(r.value, '42.0000', 'o passado não vira "dado antigo"');
  assert.equal(r.status, 'OK');
  assert.equal(r.freshness.historical, true);
  assert.equal(r.freshness.ageMinutes, 10, 'idade de quando foi gravado');
  assert.equal(r.freshness.state, 'FRESH');
  assert.equal(r.freshness.label, 'Registro de 20/10/2026', 'o selo de dia passado descreve o registro');
  const today = await metricAged(5);
  assert.equal((await e.readAsOf(tenant, today.code, TODAY)).historical, false);
});
