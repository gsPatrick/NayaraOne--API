'use strict';

// M9-D628 — a conciliação da disponibilidade não reprova por sonda que chegou DEPOIS do refresh. As sondas entram a cada minuto e a checagem recalcula a fonte; sem
// fixar o instante do refresh, qualquer sonda entre os dois fazia a contagem divergir (tolerância zero) e o indicador tec.availability ficava "não confiável" para sempre.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env628 = require('../_helpers/m9d628Env');
const quality = require('../../../src/features/analytics/quality');
const clock = require('../../../src/features/analytics/metrics/clock');

let env;
before(async () => {
  env = await env628.setup();
  for (const probe of ['API', 'DATABASE', 'QUEUE', 'STORAGE']) {
    await env628.signal(env, { kind: 'PROBE', probe, ok: true, occurredAt: env628.minutesBefore(5) });
  }
  await env628.runSchedule(env.tenantA, env628.NOW);
});
after(() => { clock.resetClock(); return env628.teardown(env); });

// a tabela de sinais só é legível pelo escritor do BI (app.analytics_writer), como no fim de um refresh
const reconcile = () => env628.inTx(env.tenantA, { commit: true }, async (tx) => {
  await env628.sequelize.query("SET LOCAL app.analytics_writer = 'on'", { transaction: tx });
  return quality.executeChecks({ readModel: 'rm_tech_availability', scope: { companyId: env.tenantA.companyId, groupId: env.tenantA.groupId }, mode: 'EVENT' }, tx);
}).then((r) => r.find((x) => x.checkCode === 'tech_availability_reconciliation'));

test('m9d628 conciliação: confere no instante do refresh', async () => {
  clock.setClock(() => env628.NOW);
  assert.equal((await reconcile()).status, 'PASSED');
});

test('m9d628 conciliação: sonda que chegou depois do refresh não reprova a conciliação', async () => {
  await env628.signal(env, { kind: 'PROBE', probe: 'API', ok: true, occurredAt: new Date(env628.NOW.getTime() + 60000) });
  clock.setClock(() => new Date(env628.NOW.getTime() + 120000));
  const out = await reconcile();
  assert.equal(out.status, 'PASSED', JSON.stringify(out.observed));
});
