'use strict';

// M9-D697 (BI-015, §18 e §21) — KPI com check BLOCK falho fica DEGRADED, sem valor definitivo e com a razão; nulo nunca vira zero; KPI composto herda a
// pior qualidade; EXPIRED vira DEGRADED sem valor e nunca é valor do enum de status. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d697Env');

let env;
let tenant;
before(async () => { env = await e.setup(); tenant = env.tenantA; });
after(() => e.teardown(env));

test('m9d697 data quality falha e o KPI fica DEGRADED sem valor', async () => {
  const m = await e.freshMetric(env, tenant);
  const antes = await e.readAsOf(tenant, m.code, e.TODAY);
  assert.deepEqual([antes.status, antes.value, antes.valueReliable], ['OK', '100.0000', true]);
  await e.recordCheck(tenant, { metrics: [m.code] });
  for (const read of [e.readAsOf, e.readValue]) {
    const r = await read(tenant, m.code, e.TODAY);
    assert.equal(r.status, 'DEGRADED');
    assert.equal(r.value, null, 'DEGRADED nunca devolve valor definitivo');
    assert.equal(r.valueReliable, false);
    assert.deepEqual(r.quality.degradedBy.map((d) => d.checkCode), ['recon_saldo']);
    assert.equal(r.quality.degradedBy[0].severity, 'CRITICAL');
    assert.equal(JSON.stringify(r.quality).includes('12.50'), false, 'a razão mostra o código do check, sem o valor observado');
  }
});

test('m9d697 check de aviso (WARN) e check que passa não degradam', async () => {
  const m = await e.freshMetric(env, tenant);
  await e.recordCheck(tenant, { checkCode: 'aviso', metrics: [m.code], severity: 'WARNING' });
  await e.recordCheck(tenant, { checkCode: 'ok', metrics: [m.code], status: 'PASSED' });
  const r = await e.readAsOf(tenant, m.code, e.TODAY);
  assert.deepEqual([r.status, r.value, r.valueReliable], ['OK', '100.0000', true]);
  await e.recordCheck(tenant, { checkCode: 'erro_de_consulta', metrics: [m.code], status: 'ERROR' });
  assert.equal((await e.readAsOf(tenant, m.code, e.TODAY)).status, 'DEGRADED', 'check em ERROR também degrada (3.5 da M9-D696)');
});

test('m9d697 INCOMPLETE nunca aparece como zero', async () => {
  const gravado = await e.freshMetric(env, tenant, { status: 'INCOMPLETE', value: '0.0000' });
  const r = await e.readAsOf(tenant, gravado.code, e.TODAY);
  assert.equal(r.status, 'INCOMPLETE');
  assert.equal(r.value, null, 'nulo != 0: o zero gravado de um INCOMPLETE não sai como valor');
  assert.equal(r.valueReliable, false);
  const degradado = await e.freshMetric(env, tenant, { status: 'DEGRADED', value: '0.0000' });
  const d = await e.readValue(tenant, degradado.code, e.TODAY);
  assert.deepEqual([d.status, d.value, d.valueReliable], ['DEGRADED', null, false]);
  const zero = await e.freshMetric(env, tenant, { value: '0.0000' });
  const z = await e.readAsOf(tenant, zero.code, e.TODAY);
  assert.deepEqual([z.status, z.value, z.valueReliable], ['OK', '0.0000', true], 'zero legítimo de um indicador OK continua zero');
});

test('m9d697 KPI composto herda a pior qualidade', async () => {
  const a = await e.freshMetric(env, tenant);
  const b = await e.freshMetric(env, tenant);
  const c = await e.freshMetric(env, tenant);
  e.registerComposite(env, c.code, [a.code, b.code]);
  assert.deepEqual([(await e.readAsOf(tenant, c.code, e.TODAY)).status, (await e.readAsOf(tenant, c.code, e.TODAY)).value], ['OK', '100.0000']);
  await e.recordCheck(tenant, { checkCode: 'payables', metrics: [a.code] });
  const r = await e.readAsOf(tenant, c.code, e.TODAY);
  assert.equal(r.status, 'DEGRADED');
  assert.equal(r.value, null);
  assert.equal(r.valueReliable, false);
  assert.deepEqual(r.quality.inheritedFrom.map((x) => x.metricCode), [a.code]);
  const outro = await e.freshMetric(env, tenant, { status: 'INCOMPLETE' });
  const root = await e.freshMetric(env, tenant);
  e.registerComposite(env, root.code, [c.code, outro.code]);
  assert.equal((await e.readAsOf(tenant, root.code, e.TODAY)).status, 'INCOMPLETE', 'composto de composto: o pior vence (INCOMPLETE > DEGRADED)');
});

test('m9d697 prioridade INCOMPLETE > DEGRADED > STALE > OK', async () => {
  const { worstStatus } = require('../../../src/features/analytics/quality');
  assert.equal(worstStatus('OK', 'STALE', 'DEGRADED'), 'DEGRADED');
  assert.equal(worstStatus('STALE', 'OK'), 'STALE');
  assert.equal(worstStatus('DEGRADED', 'INCOMPLETE', 'STALE'), 'INCOMPLETE');
  assert.equal(worstStatus('OK', 'OK'), 'OK');
  const stale = await e.freshMetric(env, tenant, { ageMinutes: 120 });
  assert.equal((await e.readAsOf(tenant, stale.code, e.TODAY)).status, 'STALE');
  await e.recordCheck(tenant, { metrics: [stale.code] });
  const r = await e.readAsOf(tenant, stale.code, e.TODAY);
  assert.equal(r.status, 'DEGRADED', 'STALE com check BLOCK falho: o pior vence');
  assert.equal(r.value, null);
});

test('m9d697 freshness EXPIRED vira DEGRADED sem valor e nunca aparece como EXPIRED no status', async () => {
  const m = await e.freshMetric(env, tenant, { ageMinutes: 5000 });
  const r = await e.readAsOf(tenant, m.code, e.TODAY);
  assert.equal(r.freshness.state, 'EXPIRED');
  assert.equal(r.status, 'DEGRADED');
  assert.equal(r.value, null);
  assert.equal(r.valueReliable, false);
  const { STATUS_ENUM } = require('../../../src/features/analytics/quality');
  assert.deepEqual([...STATUS_ENUM].sort(), ['DEGRADED', 'INCOMPLETE', 'OK', 'STALE']);
  assert.equal(STATUS_ENUM.includes('EXPIRED'), false);
});

test('m9d697 leitura de dia passado devolve o registro da época, mas valor de DEGRADED continua nulo', async () => {
  const m = await e.publish(env, tenant, {});
  await e.snapshot(tenant, { ...m, asOfDate: '2026-10-20', sourceSnapshotAt: e.minutesAgo(60 * 24 * 9), refreshedAt: e.minutesAgo(60 * 24 * 9), status: 'DEGRADED', value: '77.0000' });
  const r = await e.readAsOf(tenant, m.code, '2026-10-20');
  assert.deepEqual([r.status, r.value, r.valueReliable, r.historical], ['DEGRADED', null, false, true]);
});
