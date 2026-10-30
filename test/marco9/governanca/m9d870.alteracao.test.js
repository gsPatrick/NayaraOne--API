'use strict';

// M9-D870 — criação e alteração de flags e configurações: responsável obrigatório, versão, versão anterior guardada, auditoria, conflito de versão e reativação (banco descartável).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d870.alteracao.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d870Env');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);

test('m9d870 sem owner é recusada', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const err = await env.service.createEntry(A, { key: env.keyOf('s'), value: true }, A.userId, tx).catch((e) => e);
  assert.deepEqual([err.statusCode, err.code, err.message], [422, 'GOV_FLAG_OWNER_REQUIRED', 'Informe o responsável pela chave.']);
}));

test('m9d870 pessoa de outra empresa não pode ser responsável', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  assert.ok(await env.codeOf(env.mkFlag(A, tx, { ownerUserId: tenants.B.userId })), 'recusa o responsável que não é desta empresa');
  assert.deepEqual(await env.codeOf(env.mkFlag(A, tx, { ownerUserId: 'nao-e-uuid' })), [422, 'GOV_FLAG_OWNER_INVALID']);
}));

test('m9d870 validade invertida, valor de tipo errado e chave duplicada têm o erro do livro', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const inv = await env.service.createEntry(A, { key: env.keyOf('v'), value: true, ownerUserId: A.userId, validFrom: '2026-11-10T00:00:00Z', validUntil: '2026-11-01T00:00:00Z' }, A.userId, tx).catch((e) => e);
  assert.deepEqual([inv.statusCode, inv.code, inv.message], [422, 'GOV_FLAG_VALIDITY_INVALID', 'O fim da validade deve ser após o início.']);
  assert.deepEqual(await env.codeOf(env.mkFlag(A, tx, { validFrom: '2026-11-10T00:00:00Z', validUntil: '2026-11-10T00:00:00Z' })), [422, 'GOV_FLAG_VALIDITY_INVALID'], 'fim igual ao início também');
  const bad = await env.mkFlag(A, tx, { value: 'sim' }).catch((e) => e);
  assert.deepEqual([bad.statusCode, bad.code, bad.message], [422, 'GOV_FLAG_VALUE_INVALID', 'O valor não corresponde ao tipo da chave.']);
  for (const [valueType, value, extra] of [['INTEGER', 1.5], ['INTEGER', '3'], ['DECIMAL', 'x'], ['STRING', 5], ['JSON', 'texto'], ['ENUM', 'c', { allowedValues: ['a', 'b'] }]]) {
    assert.deepEqual(await env.codeOf(env.mkConfig(A, tx, { valueType, value, ...extra })), [422, 'GOV_FLAG_VALUE_INVALID'], `${valueType} com ${JSON.stringify(value)}`);
  }
  assert.ok((await env.mkConfig(A, tx, { valueType: 'ENUM', value: 'a', allowedValues: ['a', 'b'] })).id, 'ENUM válido');
  assert.ok((await env.mkConfig(A, tx, { valueType: 'JSON', value: { a: 1 } })).id, 'JSON válido');
  assert.deepEqual(await env.codeOf(env.mkFlag(A, tx, { kind: 'FLAG', valueType: 'INTEGER', value: 1 })), [422, 'GOV_FLAG_VALUE_INVALID'], 'flag é sempre booleana');
  const key = env.keyOf('dup');
  await env.mkFlag(A, tx, { key });
  const dup = await env.mkFlag(A, tx, { key }).catch((e) => e);
  assert.deepEqual([dup.statusCode, dup.code, dup.message], [409, 'GOV_FLAG_DUPLICATE', 'Já existe uma chave igual neste escopo.']);
  await env.mkFlag(A, tx, { key, scope: 'COMPANY', scopeRef: A.companyId });
  assert.deepEqual(await env.codeOf(env.mkConfig(A, tx, { key })), [409, 'GOV_FLAG_DUPLICATE'], 'a chave também é única entre flag e configuração');
  for (const key2 of ['Maiuscula.errada', 'semponto', 'a..b', '']) assert.deepEqual(await env.codeOf(env.mkFlag(A, tx, { key: key2 })), [422, 'GOV_FLAG_INPUT_INVALID'], `chave "${key2}"`);
  assert.deepEqual(await env.codeOf(env.mkFlag(A, tx, { scope: 'COMPANY', scopeRef: tenants.B.companyId })), [422, 'GOV_FLAG_INPUT_INVALID'], 'empresa de outro grupo');
  assert.deepEqual(await env.codeOf(env.mkFlag(A, tx, { risk: 'EXTREME' })), [422, 'GOV_FLAG_INPUT_INVALID']);
}));

test('m9d870 alteração incrementa versão e guarda a anterior', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const flag = await env.mkFlag(A, tx, { value: false, risk: 'LOW' });
  assert.deepEqual([flag.version, flag.state, flag.kind, flag.valueType, flag.ownerUserId, flag.scope], [1, 'ACTIVE', 'FLAG', 'BOOLEAN', A.userId, 'GLOBAL']);
  const v2 = await env.patch(A, tx, { id: flag.id, value: true, reason: 'Ligar para o piloto.' });
  assert.deepEqual([v2.version, v2.value, v2.unchanged], [2, true, false]);
  await env.patch(A, tx, { id: flag.id, risk: 'HIGH', reason: 'Risco reavaliado.' });
  const v4 = await env.patch(A, tx, { id: flag.id, value: false, reason: 'Desligar de volta.' });
  assert.deepEqual([v4.version, v4.value], [4, false], 'version 3 -> 4');
  const old = await env.versionsOf(flag.id, tx);
  assert.deepEqual(old.map((r) => [r.version, r.value, r.risk]), [[1, false, 'LOW'], [2, true, 'LOW'], [3, true, 'HIGH']], 'cada versão anterior fica guardada com o valor que tinha');
  assert.ok(old.every((r) => r.replaced_reason && r.replaced_by === A.userId));
  const scoped = await env.patch(A, tx, { id: flag.id, scope: 'COMPANY', scopeRef: A.companyId, reason: 'Passa a valer só para a empresa.' });
  assert.deepEqual([scoped.version, scoped.scope, scoped.scopeRef], [5, 'COMPANY', A.companyId], 'alterar o escopo também sobe a versão');
  const dated = await env.patch(A, tx, { id: flag.id, validUntil: env.isoIn(86400000), reason: 'Prazo.' });
  assert.equal(dated.version, 6, 'alterar a validade também sobe a versão');
}));

test('m9d870 alteração audita antes e depois com o motivo, e o motivo é obrigatório', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const flag = await env.mkFlag(A, tx, { value: false });
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: flag.id, value: true })), [422, 'GOV_FLAG_REASON_REQUIRED']);
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: flag.id, value: true, reason: '   ' })), [422, 'GOV_FLAG_REASON_REQUIRED']);
  await env.patch(A, tx, { id: flag.id, value: true, reason: 'Liberar.' });
  const trail = await env.auditOf(flag.id, tx);
  assert.equal(trail.length, 2, 'criação e alteração');
  assert.equal(trail[0].beforeJson, null);
  assert.deepEqual([trail[1].beforeJson.value, trail[1].beforeJson.version, trail[1].afterJson.value, trail[1].afterJson.version, trail[1].reason], [false, 1, true, 2, 'Liberar.']);
  assert.equal(trail[1].userId, A.userId);
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: env.randomUUID(), value: true, reason: 'x' })), [404, 'GOV_FLAG_NOT_FOUND']);
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { reason: 'x' })), [422, 'GOV_FLAG_INPUT_INVALID']);
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: flag.id, key: 'outra.chave.nome', reason: 'x' })), [422, 'GOV_FLAG_INPUT_INVALID'], 'a chave não muda');
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: flag.id, ownerUserId: null, reason: 'x' })), [422, 'GOV_FLAG_OWNER_REQUIRED'], 'não dá para tirar o responsável');
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: flag.id, value: 'sim', reason: 'x' })), [422, 'GOV_FLAG_VALUE_INVALID']);
}));

test('m9d870 conflito de versão devolve 409', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const flag = await env.mkFlag(A, tx, { value: false });
  await env.patch(A, tx, { id: flag.id, version: 1, value: true, reason: 'Primeira.' });
  const err = await env.patch(A, tx, { id: flag.id, version: 1, value: false, reason: 'Segunda, com versão velha.' }).catch((e) => e);
  assert.deepEqual([err.statusCode, err.code], [409, 'GOV_FLAG_VERSION_CONFLICT']);
  assert.deepEqual([err.details.currentVersion, err.details.sentVersion], [2, 1]);
  const [still] = (await env.service.listEntries(A, { id: flag.id }, A.userId, tx)).itens;
  assert.deepEqual([still.version, still.value], [2, true], 'a alteração recusada não gravou nada');
  assert.equal((await env.patch(A, tx, { id: flag.id, version: 2, value: false, reason: 'Com a versão certa.' })).version, 3);
}));

test('m9d870 PATCH com o mesmo valor não gera versão nem auditoria', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const flag = await env.mkFlag(A, tx, { value: true, description: 'a' });
  const same = await env.patch(A, tx, { id: flag.id, value: true, description: 'a', reason: 'Igual.' });
  assert.deepEqual([same.unchanged, same.version], [true, 1]);
  assert.equal((await env.versionsOf(flag.id, tx)).length, 0);
  assert.equal((await env.auditOf(flag.id, tx)).length, 1, 'só a criação');
}));

test('m9d870 PATCH que estende valid_until reativa flag EXPIRED', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const flag = await env.mkFlag(A, tx, { value: true, scope: 'COMPANY', scopeRef: A.companyId, validUntil: env.isoIn(3600000) });
  await env.sequelize.query("UPDATE governance.feature_flags SET state = 'EXPIRED', valid_until = now() - interval '1 day' WHERE id = :id", { transaction: tx, replacements: { id: flag.id } });
  assert.equal((await env.resolve(A, flag.key, {}, tx)).found, false, 'EXPIRED não resolve');
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: flag.id, description: 'sem estender', reason: 'x' })), [422, 'GOV_FLAG_EXPIRED'], 'sem estender a validade não reativa');
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: flag.id, validUntil: '2020-01-01T00:00:00Z', reason: 'x' })), [422, 'GOV_FLAG_EXPIRED'], 'data passada não reativa');
  const back = await env.patch(A, tx, { id: flag.id, validUntil: env.isoIn(7 * 86400000), reason: 'Prorrogada pelo responsável.' });
  assert.deepEqual([back.state, back.version], ['ACTIVE', 2]);
  assert.equal((await env.resolve(A, flag.key, {}, tx)).value, true, 'a chave volta a valer sem ter sido apagada');
  const trail = await env.auditOf(flag.id, tx);
  assert.deepEqual([trail[1].beforeJson.state, trail[1].afterJson.state], ['EXPIRED', 'ACTIVE']);
}));

test('m9d870 kill switch e tipo não mudam depois de criados', { skip: skip() }, () => run(async (tx) => {
  const A = tenants.A;
  const flag = await env.mkFlag(A, tx, { isKillSwitch: true, risk: 'CRITICAL' });
  assert.equal(flag.isKillSwitch, true);
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: flag.id, isKillSwitch: false, reason: 'x' })), [422, 'GOV_FLAG_INPUT_INVALID']);
  assert.deepEqual(await env.codeOf(env.patch(A, tx, { id: flag.id, valueType: 'STRING', reason: 'x' })), [422, 'GOV_FLAG_INPUT_INVALID']);
}));
