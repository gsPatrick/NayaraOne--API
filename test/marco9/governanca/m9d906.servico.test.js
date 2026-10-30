'use strict';

// M9-D906 — IDs legados em core.external_refs: preservação, unicidade vigente, histórico, lookup por data, imutabilidade, idempotência, fidelidade da chave, RLS. Banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d906Env');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const run = (fn) => env.withRollbackTenantTransaction(tenants.A, fn);
const code = (promise) => promise.then(() => null, (err) => err.code);
const { externalRefs } = env;

test('m9d906 ID legado fica ligado ao registro migrado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const p1 = await env.person(A(), tx);
    const created = await env.ref(A(), tx, p1.id, '8412');
    assert.deepEqual([created.sourceSystem, created.sourceKey, created.entityType, created.entityId, created.validTo, created.isPrimary], ['LEGADO_ERP', '8412', 'PERSON', p1.id, null, true]);
    const found = await externalRefs.lookup(A(), 'LEGADO_ERP', '8412', undefined, { entityType: 'PERSON' }, tx);
    assert.equal(found.entityId, p1.id);
    const audit = await env.query("SELECT action FROM audit.audit_log WHERE entity_id = :id AND action LIKE 'migration.external_ref.%'", { id: created.id }, tx);
    assert.deepEqual(audit.map((a) => a.action), ['migration.external_ref.created']);
  });
});

test('m9d906 segundo vigente com a mesma chave é recusado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const p1 = await env.person(A(), tx);
    const p2 = await env.person(A(), tx);
    await env.ref(A(), tx, p1.id, '8412');
    const err = await env.ref(A(), tx, p2.id, '8412').then(() => null, (e) => e);
    assert.deepEqual([err.statusCode, err.code, err.message], [409, 'GOV_EXTREF_DUPLICATE', 'Este código antigo já está ligado a outro registro.']);
  });
});

test('m9d906 merge fecha e reabre a referência preservando histórico', { skip: skip() }, async () => {
  await run(async (tx) => {
    const p1 = await env.person(A(), tx);
    const p2 = await env.person(A(), tx);
    await env.ref(A(), tx, p1.id, '8412', { validFrom: '2026-01-01T00:00:00Z' });
    const moved = await externalRefs.repoint(A(), env.actorOf(A()), { fromEntityId: p1.id, toEntityId: p2.id }, tx);
    assert.equal(moved.length, 1);
    const old = await env.rows(p1.id, tx);
    assert.equal(old.length, 1, 'a linha antiga continua existindo');
    assert.ok(old[0].valid_to, 'e está fechada');
    const fresh = await env.rows(p2.id, tx);
    assert.deepEqual([fresh.length, fresh[0].source_key, fresh[0].valid_to, fresh[0].is_primary], [1, '8412', null, true]);
    assert.equal((await externalRefs.lookup(A(), 'LEGADO_ERP', '8412', undefined, { entityType: 'PERSON' }, tx)).entityId, p2.id);
    const audit = await env.query("SELECT action FROM audit.audit_log WHERE company_id = :c AND action LIKE 'migration.external_ref.%' ORDER BY occurred_at, action", { c: A().companyId }, tx);
    assert.ok(audit.some((a) => a.action === 'migration.external_ref.closed') && audit.some((a) => a.action === 'migration.external_ref.created'));
  });
});

test('m9d906 lookup em data passada devolve a entidade antiga', { skip: skip() }, async () => {
  await run(async (tx) => {
    const p1 = await env.person(A(), tx);
    const p2 = await env.person(A(), tx);
    await env.ref(A(), tx, p1.id, '8412', { validFrom: '2026-01-01T00:00:00Z' });
    await externalRefs.repoint(A(), env.actorOf(A()), { fromEntityId: p1.id, toEntityId: p2.id }, tx);
    const past = await externalRefs.lookup(A(), 'LEGADO_ERP', '8412', '2026-06-01T00:00:00Z', { entityType: 'PERSON' }, tx);
    assert.equal(past.entityId, p1.id);
    const now = await externalRefs.lookup(A(), 'LEGADO_ERP', '8412', undefined, { entityType: 'PERSON' }, tx);
    assert.equal(now.entityId, p2.id);
    assert.equal(await code(externalRefs.lookup(A(), 'LEGADO_ERP', '8412', '2025-01-01T00:00:00Z', { entityType: 'PERSON' }, tx)), 'GOV_NOT_FOUND', 'antes de existir a referência não há entidade');
  });
});

test('m9d906 referência não pode ser apagada', { skip: skip() }, async () => {
  await run(async (tx) => {
    const p1 = await env.person(A(), tx);
    const created = await env.ref(A(), tx, p1.id, '8412');
    const err = await externalRefs.remove(A(), env.actorOf(A()), created.id, tx).then(() => null, (e) => e);
    assert.deepEqual([err.code, err.message], ['GOV_EXTREF_IMMUTABLE', 'Referências antigas não podem ser apagadas; encerre a vigência.']);
    assert.match(String(await env.dbError(tx, 'DELETE FROM core.external_refs WHERE id = :id', { id: created.id })), /imut/i);
    assert.equal((await env.rows(p1.id, tx)).length, 1);
    assert.match(String(await env.dbError(tx, "UPDATE core.external_refs SET source_key = '1' WHERE id = :id", { id: created.id })), /imut/i);
    assert.match(String(await env.dbError(tx, 'UPDATE core.external_refs SET valid_to = now() WHERE id = :id AND valid_to IS NULL; UPDATE core.external_refs SET valid_to = NULL WHERE id = :id', { id: created.id })), /imut/i, 'a vigência fechada não reabre');
  });
});

test('m9d906 replay não duplica', { skip: skip() }, async () => {
  await run(async (tx) => {
    const p1 = await env.person(A(), tx);
    const first = await env.ref(A(), tx, p1.id, '8412');
    const again = await env.ref(A(), tx, p1.id, '8412');
    assert.deepEqual([again.id, again.created, first.created], [first.id, false, true]);
    assert.equal((await env.rows(p1.id, tx)).length, 1);
  });
});

test('m9d906 chaves com zero à esquerda são distintas', { skip: skip() }, async () => {
  await run(async (tx) => {
    const p1 = await env.person(A(), tx);
    const p2 = await env.person(A(), tx);
    await env.ref(A(), tx, p1.id, '00077');
    await env.ref(A(), tx, p2.id, '77');
    assert.equal((await externalRefs.lookup(A(), 'LEGADO_ERP', '00077', undefined, { entityType: 'PERSON' }, tx)).entityId, p1.id);
    assert.equal((await externalRefs.lookup(A(), 'LEGADO_ERP', '77', undefined, { entityType: 'PERSON' }, tx)).entityId, p2.id);
    const spaced = await env.ref(A(), tx, p1.id, '  00077  ');
    assert.equal(spaced.sourceKey, '00077', 'só os espaços das pontas saem');
  });
});

test('m9d906 isolamento entre empresas', { skip: skip() }, async () => {
  const system = env.sys();
  const mine = await env.withRollbackTenantTransaction(tenants.B, async (txB) => {
    const pb = await env.person(tenants.B, txB);
    await externalRefs.register(tenants.B, env.actorOf(tenants.B), { entityType: 'PERSON', entityId: pb.id, sourceSystem: system, sourceKey: '8412' }, txB);
    return pb.id;
  });
  assert.ok(mine);
  await run(async (tx) => {
    const p1 = await env.person(A(), tx);
    await externalRefs.register(A(), env.actorOf(A()), { entityType: 'PERSON', entityId: p1.id, sourceSystem: system, sourceKey: '8412' }, tx);
    assert.equal((await env.query('SELECT count(*)::int AS n FROM core.external_refs WHERE source_system = :s', { s: system }, tx))[0].n, 1, 'só a empresa A aparece');
    const intruso = await code(externalRefs.register(A(), env.actorOf(A()), { entityType: 'PERSON', entityId: p1.id, sourceSystem: system, sourceKey: '9', groupId: tenants.B.groupId, companyId: tenants.B.companyId }, tx));
    assert.equal(intruso, null, 'o tenant vem sempre do contexto, nunca do corpo');
  });
  await env.withRollbackTenantTransaction(tenants.B, async (txB) => {
    assert.equal(await code(externalRefs.lookup(tenants.B, system, '9', undefined, { entityType: 'PERSON' }, txB)), 'GOV_NOT_FOUND');
    assert.match(String(await env.dbError(txB,
      "INSERT INTO core.external_refs (group_id, company_id, entity_type, entity_id, source_system, source_key) VALUES (:g, :c, 'PERSON', gen_random_uuid(), 'X', '1')",
      { g: tenants.A.groupId, c: tenants.A.companyId })), /row-level security|violates/i);
  });
});

test('m9d906 chave vazia devolve GOV_EXTREF_KEY_REQUIRED e lookup inexistente devolve GOV_NOT_FOUND', { skip: skip() }, async () => {
  await run(async (tx) => {
    const p1 = await env.person(A(), tx);
    const empty = await env.ref(A(), tx, p1.id, '   ').then(() => null, (e) => e);
    assert.deepEqual([empty.statusCode, empty.code, empty.message], [422, 'GOV_EXTREF_KEY_REQUIRED', 'Informe o código antigo.']);
    assert.equal(await code(env.ref(A(), tx, p1.id, null)), 'GOV_EXTREF_KEY_REQUIRED');
    const missing = await externalRefs.lookup(A(), 'LEGADO_ERP', 'nao-existe', undefined, { entityType: 'PERSON' }, tx).then(() => null, (e) => e);
    assert.deepEqual([missing.statusCode, missing.code, missing.message], [404, 'GOV_NOT_FOUND', 'Código antigo não encontrado.']);
    assert.equal(await code(env.ref(A(), tx, p1.id, 'x'.repeat(129))), 'GOV_EXTREF_KEY_INVALID');
    assert.equal(await code(env.ref(A(), tx, p1.id, '1', { entityType: 'ALIEN' })), 'GOV_EXTREF_ENTITY_TYPE_INVALID');
  });
});
