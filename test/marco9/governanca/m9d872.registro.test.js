'use strict';

// M9-D872 — registro do kill switch: probe obrigatório, risco CRITICAL, inventário e registro de probes (banco descartável).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d872.registro.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d872Env');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { env.registerTestProbe(); if (env.DISPOSABLE) { await env.isolateKillSwitches(); tenants = await env.loadTenants(); } });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);

test('m9d872 switch sem probe é recusado', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const err = await env.mkFlag(A, tx, { isKillSwitch: true, risk: 'CRITICAL' }).catch((e) => e);
  assert.deepEqual([err.statusCode, err.code, err.message], [422, 'GOV_KILL_PROBE_REQUIRED', 'Todo kill switch precisa de um teste automatizado.']);
  assert.deepEqual(await env.codeOf(env.mkFlag(A, tx, { isKillSwitch: true, risk: 'CRITICAL', probe: 'qa.nao.registrado' })), [422, 'GOV_KILL_PROBE_REQUIRED'], 'probe que não existe no código também é recusado');
  assert.deepEqual(await env.codeOf(env.mkFlag(A, tx, { probe: env.PROBE })), [422, 'GOV_FLAG_INPUT_INVALID'], 'probe só vale para kill switch');
  const ok = await env.mkSwitch(A, tx);
  assert.deepEqual([ok.isKillSwitch, ok.probe, ok.verificationState, ok.risk, ok.value], [true, env.PROBE, 'PENDING', 'CRITICAL', false]);
}));

test('m9d872 kill switch tem risco CRITICAL e é sempre uma flag', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  assert.deepEqual(await env.codeOf(env.mkSwitch(A, tx, { risk: 'LOW' })), [422, 'GOV_FLAG_INPUT_INVALID']);
  const defaulted = await env.mkSwitch(A, tx, { risk: undefined });
  assert.equal(defaulted.risk, 'CRITICAL', 'sem informar o risco, nasce CRITICAL');
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: defaulted.id, risk: 'LOW', reason: 'baixar' })), [422, 'GOV_FLAG_INPUT_INVALID'], 'não rebaixa o risco de um kill switch');
  assert.deepEqual(await env.codeOf(env.mkConfig(A, tx, { isKillSwitch: true, risk: 'CRITICAL', probe: env.PROBE })), [422, 'GOV_FLAG_INPUT_INVALID'], 'configuração não é kill switch');
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: defaulted.id, probe: 'outro.probe', reason: 'x' })), [422, 'GOV_FLAG_INPUT_INVALID'], 'o probe não muda depois de criado');
}));

test('m9d872 todo kill switch do registro tem probe', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  await env.mkSwitch(A, tx);
  await env.mkSwitch(A, tx, { scope: 'COMPANY', scopeRef: A.companyId });
  const missing = await env.status.switchesWithoutProbe(A, tx);
  assert.deepEqual(missing, [], 'o inventário (consulta is_kill_switch = true) não acha switch sem probe');
  // o banco recusa kill switch sem probe e sem risco CRITICAL, mesmo fora do serviço (savepoint: a recusa não derruba a transação do teste)
  const plain = await env.mkFlag(A, tx, { risk: 'CRITICAL' });
  const mark = () => env.sequelize.transaction({ transaction: tx }, (sp) => env.sequelize.query('UPDATE governance.feature_flags SET is_kill_switch = true WHERE id = :id', { transaction: sp, replacements: { id: plain.id } }));
  await assert.rejects(mark(), /gov_feature_flags_kill_probe_chk/);
  // probe que sumiu do código (renomeado/removido) é pego pelo inventário
  const orphan = await env.mkSwitch(A, tx);
  await env.sequelize.query("UPDATE governance.feature_flags SET probe = 'qa.removido.do_codigo' WHERE id = :id", { transaction: tx, replacements: { id: orphan.id } });
  assert.deepEqual((await env.status.switchesWithoutProbe(A, tx)).map((r) => r.key), [orphan.key]);
  const listed = await env.service.listEntries(A, { kind: 'FLAG', key: 'qa.m9d872' }, A.userId, tx);
  assert.ok(listed.itens.every((i) => 'verificationState' in i && 'probe' in i));
}));

test('m9d872 registro de probes: nome, versão e função obrigatórios; nome repetido com outra função é recusado', () => {
  assert.throws(() => env.probes.registerProbe({ name: 'Ruim', version: '1', run() {} }), /nome/i);
  assert.throws(() => env.probes.registerProbe({ name: 'qa.m9d872.sem_versao', run() {} }), /versão/i);
  assert.throws(() => env.probes.registerProbe({ name: 'qa.m9d872.sem_run', version: '1' }), /função/i);
  const p = { name: 'qa.m9d872.repetido', version: '1', run: async () => ({ pass: true }) };
  env.probes.registerProbe(p);
  env.probes.registerProbe(p);
  assert.throws(() => env.probes.registerProbe({ ...p, run: async () => ({ pass: false }) }), /já registrado/i);
  assert.equal(env.probes.getProbe('qa.m9d872.repetido').version, '1');
  assert.equal(env.probes.getProbe('qa.m9d872.inexistente'), null);
  assert.ok(env.probes.listProbes().some((x) => x.name === 'qa.m9d872.repetido'));
});
