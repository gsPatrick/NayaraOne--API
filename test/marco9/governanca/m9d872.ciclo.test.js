'use strict';

// M9-D872 — ciclo diário do kill switch: UNVERIFIED reexecuta todo dia até PASS, restauração depois de queda no meio, um drill por switch e dia, isolamento e o job (banco descartável).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d872.ciclo.test.js"

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d872Env');
const { isDue, runKillSwitchDrillJob } = require('../../../src/engines/jobs/killSwitchDrillJob');
const { readFlagsParams } = require('../../../src/features/core-governance/feature-flags/flags.params');
const { FLAGS_SETTINGS_SCHEMA, KEYS } = require('../../../src/features/core-governance/feature-flags/flags.settings');
const { GOVERNANCE_SETTINGS_SCHEMA } = require('../../../src/features/core-governance/governance.settings');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) { await env.isolateKillSwitches(); tenants = await env.loadTenants(); } });
beforeEach(() => { env.registerTestProbe('1'); env.behavior.calls = 0; });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const day = (n) => new Date(env.NOW.getTime() + n * 86400000);

test('m9d872 FAIL reexecuta diariamente até PASS e libera', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const sw = await env.mkSwitch(A, tx);
  let healthy = false;
  env.behavior.run = async () => ({ pass: healthy, evidence: { healthy } });
  const d1 = await env.cycle.runCycle(A, { environment: 'HOMOLOG', now: env.NOW, transaction: tx });
  assert.deepEqual(d1.drills.map((d) => [d.key, d.result]), [[sw.key, 'FAIL']]);
  assert.equal((await env.stateOf(A, sw, tx)).verification, 'UNVERIFIED');
  const sameDay = await env.cycle.runCycle(A, { environment: 'HOMOLOG', now: new Date(env.NOW.getTime() + 3600000), transaction: tx });
  assert.equal(sameDay.drills.length, 0, 'no máximo um drill por switch e dia');
  const d2 = await env.cycle.runCycle(A, { environment: 'HOMOLOG', now: day(1), transaction: tx });
  assert.deepEqual(d2.drills.map((d) => d.result), ['FAIL'], 'no dia seguinte tenta de novo (UNVERIFIED)');
  healthy = true;
  const d3 = await env.cycle.runCycle(A, { environment: 'HOMOLOG', now: day(2), transaction: tx });
  assert.deepEqual(d3.drills.map((d) => d.result), ['PASS']);
  assert.equal((await env.stateOf(A, sw, tx)).verification, 'VERIFIED', 'o PASS libera');
  const d4 = await env.cycle.runCycle(A, { environment: 'HOMOLOG', now: day(3), transaction: tx });
  assert.equal(d4.drills.length, 0, 'verificado e em dia: não testa de novo');
  assert.deepEqual((await env.drillsOf(tx, sw.key)).map((r) => r.result), ['FAIL', 'FAIL', 'PASS']);
}));

test('m9d872 o ciclo testa o switch que venceu e o que nunca foi testado, e não os que estão em dia', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const never = await env.mkSwitch(A, tx);
  const old = await env.mkSwitch(A, tx);
  const fine = await env.mkSwitch(A, tx);
  await env.insertDrill(A, tx, old, { daysAgo: 40 });
  await env.insertDrill(A, tx, fine, { daysAgo: 5 });
  env.behavior.run = async () => ({ pass: true });
  const result = await env.cycle.runCycle(A, { environment: 'DEV', now: env.NOW, transaction: tx });
  assert.deepEqual(result.drills.map((d) => d.key).sort(), [never.key, old.key].sort());
  assert.deepEqual(result.stale, [], 'depois do PASS nada vence');
  assert.equal(env.behavior.calls, 2);
}));

test('m9d872 job que caiu no meio: a execução seguinte restaura o estado gravado antes de qualquer outra coisa', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const sw = await env.mkSwitch(A, tx);
  await env.service.updateEntry(A, { id: sw.id, value: true, reason: 'acionado pelo drill que caiu' }, null, tx);
  await env.insertDrill(A, tx, sw, { result: 'RUNNING', environment: 'HOMOLOG', previous: false, at: new Date(env.NOW.getTime() - 3600000).toISOString() });
  assert.equal((await env.stateOf(A, sw, tx)).value, true);
  const order = [];
  env.behavior.run = async () => { order.push(`probe:${(await env.stateOf(A, sw, tx)).value}`); return { pass: true }; };
  const result = await env.cycle.runCycle(A, { environment: 'HOMOLOG', now: env.NOW, transaction: tx });
  assert.deepEqual(result.recovered, [sw.key]);
  const rows = await env.drillsOf(tx, sw.key);
  assert.equal(rows[0].result, 'FAIL');
  assert.equal(rows[0].evidence.interrupted, true);
  assert.equal((await env.stateOf(A, sw, tx)).value, false, 'restaurado ao previous_state gravado');
  assert.deepEqual(order, ['probe:true'], 'o novo drill só começa depois da restauração (acionou de novo a partir de desligado)');
  assert.equal(rows.length, 2);
}));

test('m9d872 um drill ainda em andamento (dentro da tolerância) não é restaurado por outro processo', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const sw = await env.mkSwitch(A, tx);
  await env.service.updateEntry(A, { id: sw.id, value: true, reason: 'em andamento' }, null, tx);
  await env.insertDrill(A, tx, sw, { result: 'RUNNING', environment: 'HOMOLOG', at: new Date(env.NOW.getTime() - 60000).toISOString() });
  const result = await env.cycle.runCycle(A, { environment: 'HOMOLOG', now: env.NOW, transaction: tx });
  assert.deepEqual(result.recovered, []);
  assert.equal((await env.stateOf(A, sw, tx)).value, true, 'segue acionado: o outro processo ainda está testando');
}));

test('m9d872 isolamento entre empresas', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const sw = await env.mkSwitch(A, tx);
  env.behavior.run = async () => ({ pass: true });
  const other = await env.cycle.runCycle(tenants.B, { environment: 'HOMOLOG', now: env.NOW, transaction: tx });
  assert.deepEqual([other.drills.length, other.stale.length], [0, 0], 'a outra empresa não enxerga o switch de A');
  assert.equal((await env.drillsOf(tx, sw.key)).length, 0);
  const err = await env.drill.runDrill(tenants.B, sw.id, { environment: 'HOMOLOG', now: env.NOW, transaction: tx }).catch((e) => e);
  assert.equal(err.code, 'GOV_FLAG_NOT_FOUND');
}));

test('m9d872 horário do job, periodicidade e tolerância são parâmetros do administrador', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const params = await readFlagsParams(A, tx);
  assert.deepEqual([params.killDays, params.killHour, params.killMinute, params.killToleranceMin], [30, 5, 0, 10]);
  const t = { companyId: 'empresa-qa-872' };
  assert.equal(isDue(t, params, new Date('2026-10-27T07:59:00Z'), false), false, '05:00 de Brasília = 08:00Z');
  assert.equal(isDue(t, params, new Date('2026-10-27T08:00:00Z'), false), true);
  assert.equal(isDue(t, { ...params, killHour: 7 }, new Date('2026-10-27T08:00:00Z'), false), false);
  assert.equal(isDue(t, params, new Date('2026-10-27T07:00:00Z'), true), true);
  for (const k of [KEYS.killDays, KEYS.killHour, KEYS.killMinute, KEYS.killToleranceMin]) assert.ok(k in FLAGS_SETTINGS_SCHEMA && k in GOVERNANCE_SETTINGS_SCHEMA, k);
}));

test('m9d872 o job percorre as empresas sem erro', { skip: skip() }, async () => {
  const result = await runKillSwitchDrillJob(env.NOW, { force: true, environment: 'HOMOLOG' });
  assert.equal(result.errors, 0);
  assert.ok(result.summaries.every((s) => Array.isArray(s.drills)));
});
