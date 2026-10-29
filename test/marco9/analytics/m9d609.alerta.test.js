'use strict';

// M9-D609 (§21) — "Snapshot antigo exibido como atual -> freshness alerta": métrica CRITICAL com dado STALE/EXPIRED publica o alerta técnico
// `analytics.freshness.stale`. A abertura da instância do alerta (alert_instances) pelo alert engine é provada junto na M9-D691
// (test/marco9/analytics/m9d691.freshness.test.js). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d609Env');
const signal = require('../../../src/features/analytics/metrics/freshness.signal');

const NOW = '2026-10-29T15:00:00Z';
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

async function aged(age, extra) {
  const m = await e.publish(env, tenant, extra);
  await e.snapshot(tenant, { ...m, asOfDate: TODAY, sourceSnapshotAt: minutesAgo(age), refreshedAt: NOW });
  return m;
}
const scan = (t = tenant) => e.sup.inTx(t, {}, (tx) => signal.collectCriticalStaleness({ companyId: t.companyId, groupId: t.groupId }, tx));

test('m9d609 snapshot antigo exibido como atual dispara alerta de freshness', async () => {
  const stale = await aged(180, { criticality: 'CRITICAL' });
  const expired = await aged(300, { criticality: 'CRITICAL', prefix: 'legal' });
  const fresh = await aged(10, { criticality: 'CRITICAL' });
  const normal = await aged(600, { criticality: 'NORMAL' });

  const heard = [];
  const off = signal.onFreshnessStale((item) => heard.push(item));
  const sent = await e.sup.inTx(tenant, {}, (tx) => signal.signalCriticalStaleness({ companyId: tenant.companyId, groupId: tenant.groupId }, tx));
  off();

  const byCode = Object.fromEntries(sent.map((i) => [i.metricCode, i]));
  assert.equal(byCode[stale.code].state, 'STALE');
  assert.equal(byCode[stale.code].ageMinutes, 180);
  assert.equal(byCode[stale.code].type, 'analytics.freshness.stale');
  assert.equal(byCode[expired.code].state, 'EXPIRED');
  assert.equal(byCode[expired.code].domain, 'LEGAL');
  assert.ok(!byCode[fresh.code], 'métrica crítica em dia não alerta');
  assert.ok(!byCode[normal.code], 'só métrica CRITICAL alerta');
  assert.deepEqual(heard.map((h) => h.metricCode).sort(), [stale.code, expired.code].sort(), 'o assinante (alert engine) recebeu cada uma');
  assert.ok(byCode[stale.code].snapshotId, 'o alerta aponta o snapshot visto');
});

test('m9d609 o alerta de freshness respeita o limite configurado e não vaza para outra empresa', async () => {
  const m = await aged(100, { criticality: 'CRITICAL', prefix: 'tec' });
  assert.ok((await scan()).some((i) => i.metricCode === m.code), '100 min contra o limite 60: vencida');
  await e.setSetting(env, tenant, 'analytics.freshness.max_minutos.TECH_AI', 500);
  assert.ok(!(await scan()).some((i) => i.metricCode === m.code), 'limite do domínio ampliado pelo administrador: em dia');
  assert.deepEqual((await scan(env.tenantB)).filter((i) => i.metricCode === m.code), [], 'outra empresa não vê a métrica');
});
