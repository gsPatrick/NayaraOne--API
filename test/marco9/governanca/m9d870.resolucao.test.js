'use strict';

// M9-D870 — resolução do valor da flag: escopo mais específico vigente vence; fora da validade a entrada é ignorada (banco descartável).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d870.resolucao.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d870Env');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);

test('m9d870 precedência de escopo', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const key = env.keyOf('prec');
  await env.mkFlag(A, tx, { key, value: false, scope: 'GLOBAL' });
  assert.deepEqual((({ value, found, origin }) => [value, found, origin.scope])(await env.resolve(A, key, {}, tx)), [false, true, 'GLOBAL']);
  const company = await env.mkFlag(A, tx, { key, value: true, scope: 'COMPANY', scopeRef: A.companyId });
  const r = await env.resolve(A, key, {}, tx);
  assert.deepEqual([r.value, r.version, r.origin.scope, r.origin.entryId, r.kind], [true, 1, 'COMPANY', company.id, 'FLAG'], 'GLOBAL=false e COMPANY=true resolve true para a empresa');
  // a ordem completa: GROUP < COMPANY < SECTOR < USER, e ENVIRONMENT < GROUP
  await env.mkFlag(A, tx, { key, value: false, scope: 'ENVIRONMENT', scopeRef: 'PROD' });
  assert.equal((await env.resolve(A, key, {}, tx)).origin.scope, 'COMPANY', 'COMPANY vence ENVIRONMENT');
  await env.mkFlag(A, tx, { key, value: false, scope: 'GROUP', scopeRef: A.groupId });
  assert.equal((await env.resolve(A, key, {}, tx)).origin.scope, 'COMPANY', 'COMPANY vence GROUP');
  await env.mkFlag(A, tx, { key, value: false, scope: 'SECTOR', scopeRef: 'obras' });
  assert.equal((await env.resolve(A, key, {}, tx)).origin.scope, 'COMPANY', 'sem informar o setor, o setor não vale');
  const bySector = await env.resolve(A, key, { sector: 'obras' }, tx);
  assert.deepEqual([bySector.origin.scope, bySector.value], ['SECTOR', false], 'SECTOR vence COMPANY para quem é do setor');
  await env.mkFlag(A, tx, { key, value: true, scope: 'USER', scopeRef: A.userId });
  const byUser = await env.resolve(A, key, { sector: 'obras', userId: A.userId }, tx);
  assert.deepEqual([byUser.origin.scope, byUser.value], ['USER', true], 'USER é o mais específico');
  assert.equal((await env.resolve(A, key, { sector: 'obras', userId: env.randomUUID() }, tx)).origin.scope, 'SECTOR', 'outra pessoa não pega a chave de USER');
  assert.equal((await env.resolve(A, key, { environment: 'DEV' }, tx)).origin.scope, 'COMPANY', 'ambiente que não casa é ignorado');
}));

test('m9d870 sem nenhuma entrada vale o padrão do código, com origem DEFAULT', { skip: skip() }, () => run(async (tx) => {
  const r = await env.resolve(tenants.A, env.keyOf('nada'), {}, tx, { defaultValue: 'padrao' });
  assert.deepEqual([r.found, r.value, r.version, r.origin.scope], [false, 'padrao', null, 'DEFAULT']);
}));

test('m9d870 entrada fora da validade é ignorada', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const key = env.keyOf('validade');
  await env.mkFlag(A, tx, { key, value: false, scope: 'GLOBAL' });
  const vencida = await env.mkFlag(A, tx, { key, value: true, scope: 'COMPANY', scopeRef: A.companyId, validFrom: '2026-10-01T00:00:00Z', validUntil: '2026-10-26T00:00:00Z' });
  const hoje = new Date('2026-10-27T12:00:00Z');
  const fora = await env.resolve(A, key, {}, tx, { now: hoje });
  assert.deepEqual([fora.value, fora.origin.scope], [false, 'GLOBAL'], 'valid_until 26/10 e hoje 27/10: ignorada, vale o escopo seguinte');
  const dentro = await env.resolve(A, key, {}, tx, { now: new Date('2026-10-20T12:00:00Z') });
  assert.deepEqual([dentro.value, dentro.origin.entryId], [true, vencida.id], 'dentro da validade vale');
  assert.equal((await env.resolve(A, key, {}, tx, { now: new Date('2026-10-26T00:00:00Z') })).origin.scope, 'GLOBAL', 'valid_until é exclusivo (now >= valid_until ignora)');
  assert.equal((await env.resolve(A, key, {}, tx, { now: new Date('2026-09-30T23:59:59Z') })).origin.scope, 'GLOBAL', 'antes do valid_from também é ignorada');
  assert.equal((await env.resolve(A, key, {}, tx, { now: new Date('2026-10-01T00:00:00Z') })).origin.scope, 'COMPANY', 'valid_from é inclusivo');
}));

test('m9d870 sem escopo seguinte nem padrão, entrada vencida resolve o padrão do código', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const key = env.keyOf('so_vencida');
  await env.mkFlag(A, tx, { key, value: true, validUntil: '2026-10-26T00:00:00Z' });
  const r = await env.resolve(A, key, {}, tx, { now: new Date('2026-10-27T00:00:00Z'), defaultValue: false });
  assert.deepEqual([r.found, r.value, r.origin.scope], [false, false, 'DEFAULT']);
}));

test('m9d870 isolamento entre empresas na resolução (RLS)', { skip: skip() }, async () => {
  const A = tenants.A;
  const key = env.keyOf('rls');
  await env.adminQuery(
    `INSERT INTO governance.feature_flags (group_id, company_id, key, value, value_type, owner_user_id, scope, scope_ref, risk) VALUES ($1, $2, $3, 'true', 'BOOLEAN', $4, 'COMPANY', $5, 'LOW')`,
    [A.groupId, A.companyId, key, A.userId, A.companyId]
  );
  try {
    await run(async (tx) => assert.equal((await env.resolve(A, key, {}, tx)).value, true, 'o A enxerga a própria chave'));
    await run(async (tx) => {
      // mesmo que o B peça a chave do A pelo contexto do A, a política da empresa esconde a linha
      const forged = await env.resolve({ groupId: A.groupId, companyId: A.companyId }, key, {}, tx);
      assert.equal(forged.found, false, 'com a sessão do B, a linha do A não existe');
      assert.equal((await env.resolve(tenants.B, key, {}, tx)).found, false);
    }, tenants.B);
  } finally {
    await env.adminQuery('DELETE FROM governance.feature_flags WHERE key = $1', [key]);
  }
});
