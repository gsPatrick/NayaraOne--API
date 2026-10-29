'use strict';

// M9-D697 (3.6) — recuperação automática no refresh seguinte e eventos analytics.quality.degraded / analytics.quality.recovered. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d697Env');
const quality = require('../../../src/features/analytics/quality');
const refreshStore = require('../../../src/features/analytics/readModelRefreshStore.service');
const { enableAnalyticsWriter } = require('../../../src/features/analytics/metricStore.service');

let env;
let tenant;
let passing = false;
before(async () => { env = await e.setup(); tenant = env.tenantA; });
after(async () => { quality.unregisterChecks(env.model); await e.teardown(env); });

const events = async (type) => (await env.admin.query(
  "SELECT event_type, aggregate_id, payload_json AS payload FROM integration.outbox_events WHERE event_type = :t AND payload_json->>'readModel' = :m ORDER BY created_at",
  { replacements: { t: type, m: env.model } }
))[0];

async function refresh() {
  return e.inTx(tenant, { commit: true }, async (tx) => {
    await enableAnalyticsWriter(tx);
    const r = await refreshStore.startRefresh({ groupId: tenant.groupId, companyId: tenant.companyId, readModel: env.model, trigger: 'EVENT', version: 1 }, tenant, tx);
    const done = await refreshStore.finishRefresh(r.id, { status: 'SUCCEEDED', rowsUpserted: 1, sourceSnapshotAt: new Date(e.NOW) }, tenant, tx);
    return quality.checkRefresh({ readModel: env.model, scope: { companyId: tenant.companyId, groupId: tenant.groupId }, refreshId: done.id, rowsUpserted: 1, mode: 'EVENT' }, tx);
  });
}

test('m9d697 recuperação automática no refresh seguinte', async () => {
  const m = await e.freshMetric(env, tenant);
  quality.registerChecks(env.model, [{ code: 'recon_caixa', type: 'RECONCILIATION', metrics: [m.code], run: async () => ({ passed: passing, severityKey: 'RECONCILIATION', expected: { diff: '0.00' }, observed: { diff: passing ? '0.00' : '9.00' } }) }]);

  e.at('2026-10-29T15:00:00Z');
  const first = await refresh();
  assert.equal(first.degraded, true);
  let r = await e.readAsOf(tenant, m.code, e.TODAY);
  assert.deepEqual([r.status, r.value], ['DEGRADED', null]);
  assert.equal((await events('analytics.quality.degraded')).length, 1, 'a passagem de OK para DEGRADED vira evento');
  const degr = (await events('analytics.quality.degraded'))[0].payload;
  assert.deepEqual([degr.metricCode, degr.checkCodes], [m.code, ['recon_caixa']]);

  await refresh(); // continua falhando: sem novo evento
  assert.equal((await events('analytics.quality.degraded')).length, 1, 'repetir a falha não repete o evento');
  assert.equal((await events('analytics.quality.recovered')).length, 0);

  passing = true;
  e.at('2026-10-29T15:05:00Z');
  await refresh();
  r = await e.readAsOf(tenant, m.code, e.TODAY);
  assert.deepEqual([r.status, r.value, r.valueReliable], ['OK', '100.0000', true], 'o refresh que passa nos checks devolve o status OK sem mão humana');
  const rec = await events('analytics.quality.recovered');
  assert.equal(rec.length, 1);
  assert.equal(rec[0].payload.metricCode, m.code);

  await refresh();
  assert.equal((await events('analytics.quality.recovered')).length, 1, 'recuperação registrada uma vez só');
});
