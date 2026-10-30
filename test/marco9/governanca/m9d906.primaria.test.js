'use strict';

// M9-D906 — merge de duplicatas com ID legado nos dois lados (uma primária, as demais não primárias), gancho da fila de merge (M9-D805) e UNIQUE parcial da primária. Banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d906Env');
const mergeService = require('../../../src/features/core-governance/data-quality/merge.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const run = (fn) => env.withRollbackTenantTransaction(tenants.A, fn);
const { externalRefs } = env;

test('m9d906 merge de duplicatas com ID legado nos dois lados abre a ref do sobrevivente como não primária', { skip: skip() }, async () => {
  await run(async (tx) => {
    const p1 = await env.person(A(), tx);
    const p2 = await env.person(A(), tx);
    await env.ref(A(), tx, p1.id, '8412', { validFrom: '2026-01-01T00:00:00Z' });
    await env.ref(A(), tx, p2.id, '9001', { validFrom: '2026-01-01T00:00:00Z' });
    await externalRefs.repoint(A(), env.actorOf(A()), { fromEntityId: p1.id, toEntityId: p2.id }, tx);
    const survivor = (await env.rows(p2.id, tx)).filter((r) => r.valid_to === null);
    const byKey = Object.fromEntries(survivor.map((r) => [r.source_key, r.is_primary]));
    assert.deepEqual(byKey, { 8412: false, 9001: true }, '9001 continua primária; 8412 entra como não primária');
    assert.equal((await externalRefs.lookup(A(), 'LEGADO_ERP', '8412', undefined, { entityType: 'PERSON' }, tx)).entityId, p2.id);
    assert.equal((await env.rows(p1.id, tx)).filter((r) => r.valid_to === null).length, 0, 'nada vigente no absorvido');
  });
});

test('m9d906 segundo ID primário vigente da mesma entidade no mesmo sistema é recusado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const p1 = await env.person(A(), tx);
    await env.ref(A(), tx, p1.id, '8412');
    const err = await env.ref(A(), tx, p1.id, '8413', { isPrimary: true }).then(() => null, (e) => e);
    assert.deepEqual([err.statusCode, err.code], [409, 'GOV_EXTREF_PRIMARY_DUPLICATE']);
    const secondary = await env.ref(A(), tx, p1.id, '8413');
    assert.equal(secondary.isPrimary, false, 'sem pedir, a segunda chave da entidade entra como não primária');
    assert.match(String(await env.dbError(tx,
      "INSERT INTO core.external_refs (group_id, company_id, entity_type, entity_id, source_system, source_key, is_primary) VALUES (:g, :c, 'PERSON', :e, 'LEGADO_ERP', '8499', true)",
      { g: A().groupId, c: A().companyId, e: p1.id })), /duplicate key|unique/i);
  });
});

test('m9d906 a decisão MERGED da fila reaponta os IDs legados na mesma transação', { skip: skip() }, async () => {
  await run(async (tx) => {
    const first = await env.person(A(), tx, { legalName: 'Maria Souza Prado' });
    const second = await env.person(A(), tx, { legalName: 'Maria Souza Prado' });
    const item = await env.candidate(A(), tx, 'PERSON', first.id, second.id);
    const survivorId = item.primary_id;
    const absorbedId = survivorId === first.id ? second.id : first.id;
    await env.ref(A(), tx, absorbedId, '8412', { validFrom: '2026-01-01T00:00:00Z' });
    await env.ref(A(), tx, survivorId, '9001', { validFrom: '2026-01-01T00:00:00Z' });
    const { actor } = await env.steward(A(), tx);
    await mergeService.decide(A(), actor, item.id, { decision: 'MERGED', survivorId, note: 'Mesma pessoa.' }, tx);
    assert.equal((await externalRefs.lookup(A(), 'LEGADO_ERP', '8412', undefined, { entityType: 'PERSON' }, tx)).entityId, survivorId);
    const vigentes = (await env.rows(survivorId, tx)).filter((r) => r.valid_to === null);
    assert.deepEqual(Object.fromEntries(vigentes.map((r) => [r.source_key, r.is_primary])), { 8412: false, 9001: true });
    assert.equal((await externalRefs.lookup(A(), 'LEGADO_ERP', '8412', '2026-06-01T00:00:00Z', { entityType: 'PERSON' }, tx)).entityId, absorbedId, 'o histórico mostra o absorvido');
  });
});
