'use strict';

// M9-D870 — GET|POST|PATCH /feature-flags pela API real: permissão, recusas do livro, auditoria e isolamento entre grupos (banco descartável).

process.env.PORT = process.env.M9D870_HTTP_TEST_PORT || '21870';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/m9d870Http');

before(async () => { await http.start(); });
after(async () => {
  if (!http.state.skip) {
    await http.adminQuery("DELETE FROM governance.flag_versions WHERE key LIKE 'qa.m9d870.%'");
    await http.adminQuery("DELETE FROM governance.feature_flags WHERE key LIKE 'qa.m9d870.%'");
  }
  await http.stop();
});
const skipReason = () => http.state.skip;
let n = 0;
const keyOf = () => `qa.m9d870.http_${Date.now().toString(36)}_${n++}`;

test('m9d870 criação, alteração e leitura pela API, com a permissão flags:manage', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  const body = { key: keyOf(), value: false, ownerUserId: A.userId, scope: 'COMPANY', scopeRef: A.companyId, risk: 'HIGH', validUntil: '2030-01-01T00:00:00Z', description: 'Piloto.' };
  assert.equal((await http.call(null, 'POST', '/feature-flags', body)).status, 401);
  const denied = await http.call('A:leitura', 'POST', '/feature-flags', body);
  assert.deepEqual([denied.status, denied.body.error.code, denied.body.error.message], [403, 'PERMISSION_DENIED', denied.body.error.message]);
  const created = await http.call('A:gestor', 'POST', '/feature-flags', body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const flag = created.body.data;
  assert.deepEqual([flag.version, flag.ownerUserId, flag.scope, flag.risk, flag.state, flag.validUntil], [1, A.userId, 'COMPANY', 'HIGH', 'ACTIVE', '2030-01-01T00:00:00.000Z']);
  const patched = await http.call('A:gestor', 'PATCH', '/feature-flags', { id: flag.id, version: 1, value: true, reason: 'Liberar o piloto.' });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.deepEqual([patched.body.data.version, patched.body.data.value], [2, true]);
  const deniedPatch = await http.call('A:leitura', 'PATCH', '/feature-flags', { id: flag.id, value: false, reason: 'x' });
  assert.deepEqual([deniedPatch.status, deniedPatch.body.error.code], [403, 'PERMISSION_DENIED']);
  const stale = await http.call('A:gestor', 'PATCH', '/feature-flags', { id: flag.id, version: 1, value: false, reason: 'Versão velha.' });
  assert.deepEqual([stale.status, stale.body.error.code, stale.body.error.message], [409, 'GOV_FLAG_VERSION_CONFLICT', 'A chave foi alterada por outra pessoa. Recarregue e tente de novo.']);
  const list = await http.call('A:gestor', 'GET', `/feature-flags?id=${flag.id}`);
  assert.equal(list.status, 200);
  assert.deepEqual([list.body.data.itens.length, list.body.data.itens[0].version, list.body.data.versoes.map((v) => v.version)], [1, 2, [1]]);
  assert.equal((await http.call('A:leitura', 'GET', '/feature-flags')).status, 403);
  const audit = await http.adminQuery("SELECT before_json, after_json, reason FROM audit.audit_log WHERE entity_id = $1 AND action = 'governance.flag.changed' ORDER BY occurred_at", [flag.id]);
  assert.equal(audit.rows.length, 2);
  assert.deepEqual([audit.rows[1].before_json.value, audit.rows[1].after_json.value, audit.rows[1].reason], [false, true, 'Liberar o piloto.']);
});

test('m9d870 recusas do livro pela API', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  const ok = { key: keyOf(), value: true, ownerUserId: A.userId };
  const owner = await http.call('A:gestor', 'POST', '/feature-flags', { key: ok.key, value: true });
  assert.deepEqual([owner.status, owner.body.error.code, owner.body.error.message], [422, 'GOV_FLAG_OWNER_REQUIRED', 'Informe o responsável pela chave.']);
  const validity = await http.call('A:gestor', 'POST', '/feature-flags', { ...ok, validFrom: '2030-02-01T00:00:00Z', validUntil: '2030-01-01T00:00:00Z' });
  assert.deepEqual([validity.status, validity.body.error.code], [422, 'GOV_FLAG_VALIDITY_INVALID']);
  const type = await http.call('A:gestor', 'POST', '/feature-flags', { ...ok, value: 'sim' });
  assert.deepEqual([type.status, type.body.error.code], [422, 'GOV_FLAG_VALUE_INVALID']);
  assert.equal((await http.call('A:gestor', 'POST', '/feature-flags', ok)).status, 201);
  const dup = await http.call('A:gestor', 'POST', '/feature-flags', ok);
  assert.deepEqual([dup.status, dup.body.error.code], [409, 'GOV_FLAG_DUPLICATE']);
  const miss = await http.call('A:gestor', 'PATCH', '/feature-flags', { id: '00000000-0000-4000-8000-000000000000', value: true, reason: 'x' });
  assert.deepEqual([miss.status, miss.body.error.code], [404, 'GOV_FLAG_NOT_FOUND']);
  assert.ok(owner.body.error.traceId, 'envelope único com traceId');
});

test('m9d870 isolamento entre empresas pela API: o grupo B não vê nem altera a chave do A', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  const created = await http.call('A:gestor', 'POST', '/feature-flags', { key: keyOf(), value: true, ownerUserId: A.userId });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  const seenByB = await http.call('B:gestor', 'GET', '/feature-flags');
  assert.equal(seenByB.status, 200);
  assert.ok(!JSON.stringify(seenByB.body.data).includes(id), 'a lista do B não traz a chave do A');
  const patchB = await http.call('B:gestor', 'PATCH', '/feature-flags', { id, value: false, reason: 'tentativa' });
  assert.deepEqual([patchB.status, patchB.body.error.code], [404, 'GOV_FLAG_NOT_FOUND']);
  const byIdB = await http.call('B:gestor', 'GET', `/feature-flags?id=${id}`);
  assert.deepEqual(byIdB.body.data.itens, []);
  const after = await http.call('A:gestor', 'GET', `/feature-flags?id=${id}`);
  assert.equal(after.body.data.itens[0].value, true);
});
