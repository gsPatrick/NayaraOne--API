'use strict';

// M9-D871 — flag temporária exige data de expiração (criação e alteração) (banco descartável).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d871.validade.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d871Env');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);

test('m9d871 temporária sem validade recusada', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const err = await env.mkFlag(A, tx, { temporary: true }).catch((e) => e);
  assert.deepEqual([err.statusCode, err.code, err.message], [422, 'GOV_FLAG_EXPIRY_REQUIRED', 'Flag temporária precisa de data de expiração.']);
  assert.deepEqual(await env.codeOf(env.mkFlag(A, tx, { temporary: true, validUntil: null })), [422, 'GOV_FLAG_EXPIRY_REQUIRED']);
  assert.deepEqual(await env.codeOf(env.mkConfig(A, tx, { temporary: true })), [422, 'GOV_FLAG_EXPIRY_REQUIRED'], 'a configuração temporária também');
  const ok = await env.mkFlag(A, tx, { temporary: true, validUntil: env.isoIn(86400000) });
  assert.equal(ok.temporary, true);
  const permanent = await env.mkFlag(A, tx, { temporary: false });
  assert.equal(permanent.validUntil, null, 'permanente continua sem validade');
}));

test('m9d871 virar temporária ou tirar a validade de uma temporária exige a data', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const perm = await env.mkFlag(A, tx);
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: perm.id, temporary: true, reason: 'Virar temporária.' })), [422, 'GOV_FLAG_EXPIRY_REQUIRED']);
  const ok = await env.patch(A, tx, { id: perm.id, temporary: true, validUntil: env.isoIn(86400000), reason: 'Virar temporária.' });
  assert.deepEqual([ok.temporary, ok.version], [true, 2]);
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: perm.id, validUntil: null, reason: 'Tirar o fim.' })), [422, 'GOV_FLAG_EXPIRY_REQUIRED'], 'não pode tirar a validade de quem é temporária');
  const back = await env.patch(A, tx, { id: perm.id, temporary: false, validUntil: null, reason: 'Voltou a ser permanente.' });
  assert.deepEqual([back.temporary, back.validUntil], [false, null]);
}));
