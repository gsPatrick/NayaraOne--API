'use strict';

// M9-D841 — avaliação diária (job das 07:00): aviso a N dias do desligamento, um evento por consumidor, reexecução sem duplicar, passagem a SUNSET e janela de uso.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d841Env');
const { runApiDeprecationJob } = require('../../../src/engines/jobs/apiDeprecationJob');

let A;
let B;
let other;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const evaluate = (tenant, now) => env.inTx(tenant, (transaction) => env.consumersApi.evaluateDeprecations({ tenant: env.tenantOf(tenant), now, transaction }));
const setParam = (tenant, key, value) => env.inTx(tenant, (tx) => require('../../../src/features/settings/settings.service').upsertSetting(key, value, env.tenantOf(tenant), tenant.userId, tx));

before(async () => { if (!env.DISPOSABLE) return; ({ A, B } = await env.loadTenants()); other = await env.otherUserId(); await env.cleanApi(); });
after(async () => { if (env.DISPOSABLE) { await env.cleanApi(); await env.adminQuery("DELETE FROM core.tenant_settings WHERE key LIKE 'governanca.api.%' AND key NOT LIKE '%rate_limit%'"); } });

test('m9d841 aviso de 30 dias publica um evento por consumidor', { skip: skip() }, async () => {
  await env.cleanApi();
  const target = 'ROUTE:GET /qa-m9/produtos/{id}';
  const sunsetAt = env.isoIn(25);
  const c1 = await env.registerConsumer(A);
  const c2 = await env.registerConsumer(A, { ownerUserId: other });
  const idle = await env.registerConsumer(A);
  const old = await env.registerConsumer(A);
  const retired = await env.registerConsumer(A);
  await env.adminQuery("UPDATE governance.api_consumers SET status = 'RETIRED' WHERE id = $1", [retired.id]);
  for (const c of [c1, c2, retired]) await env.addUsage(A, c.id, target, 2);
  await env.addUsage(A, old.id, target, 45); // visto há mais de 30 dias: não conta
  await env.addUsage(A, idle.id, 'ROUTE:GET /outra/{id}', 1);
  const dep = await env.deprecate(A, env.asOwner(A, { target, sunsetAt, replacement: '/v2/produtos/{id}' }));

  const first = await evaluate(A, new Date());
  assert.deepEqual([first.announced, first.sunset, first.events], [1, 0, 2], 'dois consumidores ativos usando o alvo na janela');
  for (const c of [c1, c2]) {
    const [event, ...rest] = await env.dueEvents(c.id);
    assert.equal(rest.length, 0, 'um por consumidor');
    assert.equal(event.idempotency_key, `api.consumer.deprecation_due:${c.id}:${target}`);
    assert.deepEqual([event.payload_json.consumerId, event.payload_json.target, event.payload_json.sunsetAt, event.payload_json.daysLeft], [c.id, target, new Date(sunsetAt).toISOString(), event.payload_json.daysLeft]);
    assert.ok(event.payload_json.daysLeft >= 24 && event.payload_json.daysLeft <= 25, `daysLeft ${event.payload_json.daysLeft}`);
  }
  for (const c of [idle, old, retired]) assert.equal((await env.dueEvents(c.id)).length, 0, 'sem uso na janela, sem uso do alvo ou consumidor desativado: sem evento');
  const notes = await env.notesOf(A, `%${target}%`);
  const byUser = notes.reduce((acc, n) => ({ ...acc, [n.userId]: (acc[n.userId] || 0) + 1 }), {});
  assert.deepEqual(byUser, { [A.userId]: 2, [other]: 1 }, 'responsável do consumidor e da deprecação avisados, sem repetir a mesma pessoa no mesmo evento');
  assert.equal((await env.depRow(dep.id)).status, 'ANNOUNCED');
});

test('m9d841 reexecutar o job não duplica o evento', { skip: skip() }, async () => {
  const [{ id }] = (await env.adminQuery("SELECT id FROM governance.api_consumers WHERE company_id = $1 AND status = 'ACTIVE' ORDER BY name LIMIT 1", [A.companyId])).rows;
  const eventsBefore = (await env.adminQuery("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'api.consumer.deprecation_due' AND company_id = $1", [A.companyId])).rows[0].n;
  const notesBefore = (await env.adminQuery('SELECT count(*)::int AS n FROM core.notifications WHERE company_id = $1', [A.companyId])).rows[0].n;
  const again = await evaluate(A, new Date());
  const forced = await runApiDeprecationJob(new Date(), { force: true });
  assert.equal(again.events, 0);
  assert.ok(forced.summaries.every((s) => s.events === 0), 'o job forçado também não republica');
  assert.equal((await env.adminQuery("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'api.consumer.deprecation_due' AND company_id = $1", [A.companyId])).rows[0].n, eventsBefore);
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM core.notifications WHERE company_id = $1', [A.companyId])).rows[0].n, notesBefore, 'nem avisa de novo');
  assert.equal((await env.dueEvents(id)).length <= 1, true);
});

test('m9d841 aviso respeita a antecedência configurada e o desligamento vira SUNSET', { skip: skip() }, async () => {
  await env.cleanApi();
  const c = await env.registerConsumer(A);
  await env.addUsage(A, c.id, 'MAJOR:3', 0);
  const dep = await env.deprecate(A, env.asOwner(A, { target: 'MAJOR:3', sunsetAt: env.isoIn(40) }));
  assert.equal((await evaluate(A, new Date())).events, 0, 'faltam 40 dias: antes do aviso de 30');
  await setParam(A, 'governanca.api.aviso_dias', 45);
  assert.equal((await evaluate(A, new Date())).events, 1, 'o administrador antecipou o aviso para 45 dias');
  const past = new Date(Date.now() + 41 * env.DAY);
  const done = await evaluate(A, past);
  assert.deepEqual([done.sunset, done.events], [1, 0], 'passado o desligamento: vira SUNSET e não avisa');
  assert.equal((await env.depRow(dep.id)).status, 'SUNSET');
  assert.equal((await env.auditOf(A, 'api.deprecation.sunset')).length > 0, true, 'passagem auditada');
  assert.equal((await evaluate(B, new Date())).announced, 0, 'a outra empresa não é tocada');
});
