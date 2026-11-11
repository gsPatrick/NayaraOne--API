'use strict';

// M9-D872 — drill do kill switch: aciona, prova com o probe e restaura SEMPRE; FAIL marca UNVERIFIED; PROD recusa; vencimento por periodicidade e por versão do probe (banco descartável).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d872.drill.test.js"

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d872Env');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) { await env.isolateKillSwitches(); tenants = await env.loadTenants(); } });
beforeEach(() => { env.registerTestProbe('1'); env.behavior.calls = 0; });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const HOMOLOG = { environment: 'HOMOLOG', now: env.NOW };

test('m9d872 drill aciona, prova e restaura', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const sw = await env.mkSwitch(A, tx);
  const seen = [];
  env.behavior.run = async (ctx) => { seen.push(await env.stopsWhenTriggered(sw.key)(ctx)); return seen.at(-1); };
  const result = await env.drill.runDrill(A, sw.id, { ...HOMOLOG, transaction: tx });
  assert.deepEqual([result.result, seen[0].pass, seen[0].evidence.observed], ['PASS', true, true], 'durante o probe o switch está acionado');
  assert.deepEqual(await env.stateOf(A, sw, tx), { value: false, verification: 'VERIFIED', version: 3 }, 'restaurado ao estado anterior; acionar e restaurar sobem a versão');
  const [row] = await env.drillsOf(tx, sw.key);
  assert.deepEqual([row.result, row.environment, row.previous_state, row.probe_version, row.flag_id], ['PASS', 'HOMOLOG', false, '1', sw.id]);
  assert.equal(row.evidence.probe, env.PROBE);
  assert.deepEqual(row.evidence.detail, { observed: true });
  assert.ok(row.finished_at && row.executed_at);
  const audit = await env.sequelize.query("SELECT action FROM audit.audit_log WHERE action = 'governance.kill_switch.drill' AND entity_id = :id", { type: 'SELECT', transaction: tx, replacements: { id: sw.id } });
  assert.equal(audit.length, 1, 'cada teste é auditado');
}));

test('m9d872 drill com função ainda ativa grava FAIL e UNVERIFIED', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const sw = await env.mkSwitch(A, tx);
  env.behavior.run = async () => ({ pass: false, evidence: { sent: 1 } });
  const result = await env.drill.runDrill(A, sw.id, { ...HOMOLOG, transaction: tx });
  assert.equal(result.result, 'FAIL');
  assert.deepEqual((await env.stateOf(A, sw, tx)).verification, 'UNVERIFIED');
  const [row] = await env.drillsOf(tx, sw.key);
  assert.deepEqual([row.result, row.evidence.detail], ['FAIL', { sent: 1 }]);
  const notes = await env.notificationsOf(A.userId, tx, sw.key);
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /CRÍTICO/);
  assert.match(notes[0].body, /não foi comprovado/i);
}));

test('m9d872 drill restaura o estado anterior mesmo com probe falhando', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const off = await env.mkSwitch(A, tx);
  env.behavior.run = async () => { throw new Error('explodiu'); };
  const result = await env.drill.runDrill(A, off.id, { ...HOMOLOG, transaction: tx });
  assert.equal(result.result, 'FAIL');
  assert.equal((await env.stateOf(A, off, tx)).value, false, 'voltou a desligado');
  const [row] = await env.drillsOf(tx, off.key);
  assert.match(row.evidence.error, /explodiu/);
  const on = await env.mkSwitch(A, tx, { value: true });
  const again = await env.drill.runDrill(A, on.id, { ...HOMOLOG, transaction: tx });
  assert.equal(again.result, 'FAIL');
  assert.equal((await env.stateOf(A, on, tx)).value, true, 'se já estava acionado, continua acionado');
  env.behavior.run = async () => ({ pass: true });
  await env.drill.runDrill(A, on.id, { ...HOMOLOG, transaction: tx });
  assert.equal((await env.stateOf(A, on, tx)).value, true, 'drill com PASS também devolve o estado anterior');
}));

test('m9d872 drill automático em PROD é recusado', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const sw = await env.mkSwitch(A, tx);
  env.behavior.run = async () => ({ pass: true });
  const err = await env.drill.runDrill(A, sw.id, { environment: 'PROD', now: env.NOW, transaction: tx }).catch((e) => e);
  assert.deepEqual([err.statusCode, err.code, err.message], [403, 'GOV_KILL_DRILL_PROD_FORBIDDEN', 'O teste automático não roda em produção.']);
  assert.equal(env.behavior.calls, 0, 'o probe nem roda');
  assert.deepEqual(await env.stateOf(A, sw, tx), { value: false, verification: 'PENDING', version: 1 }, 'o switch não é tocado');
  assert.equal((await env.drillsOf(tx, sw.key)).length, 0);
  const viaCycle = await env.cycle.runCycle(A, { environment: 'PROD', now: env.NOW, transaction: tx });
  assert.equal(viaCycle.drills.length, 0);
  assert.deepEqual(viaCycle.refused, [sw.key], 'o ciclo em PROD registra a recusa');
  assert.equal((await env.sequelize.query("SELECT 1 FROM audit.audit_log WHERE action = 'governance.kill_switch.drill_refused' AND entity_id = :id", { type: 'SELECT', transaction: tx, replacements: { id: sw.id } })).length, 1);
  const again = await env.cycle.runCycle(A, { environment: 'PROD', now: new Date(env.NOW.getTime() + 3600000), transaction: tx });
  assert.deepEqual(again.refused, [], 'a recusa é registrada uma vez por switch e dia');
}));

test('m9d872 sem PASS há mais de 30 dias alerta CRITICAL', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const fresh = await env.mkSwitch(A, tx);
  const stale = await env.mkSwitch(A, tx);
  await env.insertDrill(A, tx, fresh, { daysAgo: 29 });
  await env.insertDrill(A, tx, stale, { daysAgo: 31 });
  const result = await env.cycle.runCycle(A, { environment: 'PROD', now: env.NOW, transaction: tx });
  assert.deepEqual(result.stale, [stale.key], '29 dias ainda em dia; 31 vence');
  assert.equal((await env.notificationsOf(A.userId, tx, fresh.key)).length, 0);
  const notes = await env.notificationsOf(A.userId, tx, stale.key);
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /CRÍTICO/);
  assert.match(notes[0].body, /30 dias/);
  const same = await env.cycle.runCycle(A, { environment: 'PROD', now: new Date(env.NOW.getTime() + 3600000), transaction: tx });
  assert.deepEqual(same.stale, [stale.key]);
  assert.equal((await env.notificationsOf(A.userId, tx, stale.key)).length, 1, 'um alerta por switch e dia');
  const next = await env.cycle.runCycle(A, { environment: 'PROD', now: new Date(env.NOW.getTime() + 86400000), transaction: tx });
  assert.equal(next.stale.length, 1);
  assert.equal((await env.notificationsOf(A.userId, tx, stale.key)).length, 2, 'no dia seguinte avisa de novo');
  const never = await env.mkSwitch(A, tx);
  const r = await env.status.evaluate(A, await env.repo.findAnywhere(A, never.id, tx), { now: env.NOW, transaction: tx });
  assert.deepEqual([r.stale, r.reason, r.lastPassAt], [true, 'NEVER_PASSED', null], 'nunca testado vence');
}));

test('m9d872 a periodicidade vem do parâmetro do administrador', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const { KEYS } = require('../../../src/features/core-governance/feature-flags/flags.settings');
  const sw = await env.mkSwitch(A, tx);
  await env.insertDrill(A, tx, sw, { daysAgo: 10 });
  const row = await env.repo.findAnywhere(A, sw.id, tx);
  assert.equal((await env.status.evaluate(A, row, { now: env.NOW, transaction: tx })).stale, false);
  // governanca.flags.kill_teste_dias é sensível (requiresMfa): gravado por um operador com MFA recente real.
  await require('../../helpers/mfaRecente').gravarParametroSensivel(KEYS.killDays, 7, A, tx);
  assert.equal((await env.status.evaluate(A, row, { now: env.NOW, transaction: tx })).stale, true, 'com 7 dias, 10 dias sem PASS vence');
}));

test('m9d872 PASS de HOMOLOG da mesma probe_version vale para PROD', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const sw = await env.mkSwitch(A, tx);
  await env.insertDrill(A, tx, sw, { daysAgo: 3, environment: 'HOMOLOG', version: '1' });
  const row = await env.repo.findAnywhere(A, sw.id, tx);
  assert.equal((await env.status.evaluate(A, row, { now: env.NOW, transaction: tx })).stale, false, 'o PASS de HOMOLOG da versão atual vale');
  env.registerTestProbe('2');
  const changed = await env.status.evaluate(A, row, { now: env.NOW, transaction: tx });
  assert.deepEqual([changed.stale, changed.reason, changed.probeVersion], [true, 'PROBE_VERSION_CHANGED', '2'], 'mudou a versão do probe sem novo PASS: vence');
  env.registerTestProbe('1');
  const other = await env.mkSwitch(A, tx);
  await env.insertDrill(A, tx, other, { daysAgo: 3, environment: 'PROD' });
  assert.equal((await env.status.evaluate(A, await env.repo.findAnywhere(A, other.id, tx), { now: env.NOW, transaction: tx })).stale, true, 'PASS gravado como PROD não vale');
  const failed = await env.mkSwitch(A, tx);
  await env.insertDrill(A, tx, failed, { daysAgo: 1, environment: 'HOMOLOG', result: 'FAIL' });
  assert.equal((await env.status.evaluate(A, await env.repo.findAnywhere(A, failed.id, tx), { now: env.NOW, transaction: tx })).stale, true, 'FAIL não vale');
}));
