'use strict';

// M9-D806 — GET /data-quality (serviço): filtros, paginação, resumo por domínio e isolamento entre empresas. Banco descartável (ver m9d806.score.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d806Env');
const { evaluateEntity } = require('../../../src/features/core-governance/data-quality/quality.evaluate');
const { getDataQuality } = require('../../../src/features/core-governance/data-quality/quality.query');
const { withTenantTransaction } = require('../../testHelpers');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const run = (fn) => env.withRollbackTenantTransaction(tenants.A, fn);
const codeOf = (promise) => promise.then(() => null, (err) => [err.statusCode, err.code]);

async function seed(tx) {
  const { user } = await env.steward(A(), tx, ['PESSOAS']);
  const person = await env.fullPerson(A(), tx, {}, { contact: false });
  const property = await env.fullProperty(A(), tx, {}, { media: false });
  const supplier = await env.fullSupplier(A(), tx, { taxIdNormalized: env.invalidCnpj() });
  for (const [type, entity] of [['PERSON', person], ['PROPERTY', property], ['SUPPLIER', supplier]]) await evaluateEntity(A(), type, entity.id, tx, { actorUserId: A().userId });
  return { person, property, supplier, steward: user };
}

test('m9d806 avgScoreByDomain separa PESSOAS, IMOVEIS e FORNECEDORES', { skip: skip() }, async () => {
  await run(async (tx) => {
    const { person, property, supplier } = await seed(tx);
    const all = await getDataQuality(A(), { pageSize: '200' }, tx);
    const byEntity = Object.fromEntries(all.items.filter((i) => [person.id, property.id, supplier.id].includes(i.entityId)).map((i) => [i.entityType, i.score]));
    assert.deepEqual(byEntity, { PERSON: 85, PROPERTY: 90, SUPPLIER: 70 });
    const domains = all.summary.avgScoreByDomain;
    assert.deepEqual(Object.keys(domains).sort(), ['FORNECEDORES', 'IMOVEIS', 'PESSOAS']);
    const people = await getDataQuality(A(), { domain: 'PESSOAS', pageSize: '200' }, tx);
    assert.ok(people.items.every((i) => i.entityType === 'PERSON'));
    assert.equal(people.summary.avgScoreByDomain.PESSOAS, domains.PESSOAS);
    assert.equal(typeof all.summary.avgScore, 'number');
    assert.ok(all.summary.openIssues >= 3);
    assert.equal(typeof all.summary.domainsWithoutOwner, 'number');
  });
});

test('m9d806 filtros severity, status, entityType e stewardId; paginação respeita o limite', { skip: skip() }, async () => {
  await run(async (tx) => {
    const { supplier, person, steward } = await seed(tx);
    const critical = await getDataQuality(A(), { severity: 'CRITICAL', entityType: 'SUPPLIER', pageSize: '200' }, tx);
    const item = critical.items.find((i) => i.entityId === supplier.id);
    assert.ok(item);
    assert.deepEqual(item.issues.map((i) => i.ruleCode), ['SUPPLIER_TAX_ID_VALID']);
    assert.ok(critical.items.every((i) => i.issues.every((x) => x.severity === 'CRITICAL')));
    const open = await getDataQuality(A(), { status: 'OPEN', entityType: 'PERSON', pageSize: '200' }, tx);
    assert.ok(open.items.some((i) => i.entityId === person.id));
    const resolved = await getDataQuality(A(), { status: 'RESOLVED', entityType: 'PERSON', pageSize: '200' }, tx);
    assert.ok(!resolved.items.some((i) => i.entityId === person.id));
    const assigned = await getDataQuality(A(), { stewardId: steward.id, pageSize: '200' }, tx);
    assert.deepEqual(assigned.items.map((i) => i.entityId), [person.id], 'só a pessoa tem issue atribuída a este steward (domínio PESSOAS)');
    const nobody = await getDataQuality(A(), { stewardId: env.randomUUID(), pageSize: '200' }, tx);
    assert.equal(nobody.items.length, 0);
    const paged = await getDataQuality(A(), { pageSize: '1', page: '2' }, tx);
    assert.equal(paged.items.length, 1);
    assert.deepEqual([paged.page, paged.pageSize], [2, 1]);
    assert.ok(paged.total >= 3);
  });
});

test('m9d806 filtro domain inválido devolve 400 GOV_DQ_FILTER_INVALID', { skip: skip() }, async () => {
  await run(async (tx) => {
    assert.deepEqual(await codeOf(getDataQuality(A(), { domain: 'FINANCEIRO' }, tx)), [400, 'GOV_DQ_FILTER_INVALID']);
    assert.deepEqual(await codeOf(getDataQuality(A(), { severity: 'ALTISSIMA' }, tx)), [400, 'GOV_DQ_FILTER_INVALID']);
    assert.deepEqual(await codeOf(getDataQuality(A(), { pageSize: '201' }, tx)), [400, 'GOV_DQ_FILTER_INVALID']);
    assert.deepEqual(await codeOf(getDataQuality(A(), { stewardId: 'nao-e-uuid' }, tx)), [400, 'GOV_DQ_FILTER_INVALID']);
  });
});

test('m9d806 isolamento entre empresas: a outra empresa não vê notas nem issues', { skip: skip() }, async () => {
  const person = await withTenantTransaction(A(), async (tx) => {
    const created = await env.fullPerson(A(), tx, {}, { contact: false });
    await evaluateEntity(A(), 'PERSON', created.id, tx, { actorUserId: A().userId });
    return created;
  });
  const seenByB = await withTenantTransaction(tenants.B, (tx) => getDataQuality(tenants.B, { pageSize: '200' }, tx));
  assert.ok(!seenByB.items.some((i) => i.entityId === person.id));
  const direct = await withTenantTransaction(tenants.B, (tx) => env.query('SELECT 1 FROM governance.quality_issues WHERE entity_id = :id UNION ALL SELECT 1 FROM governance.quality_scores WHERE entity_id = :id', { id: person.id }, tx));
  assert.equal(direct.length, 0);
  const seenByA = await withTenantTransaction(A(), (tx) => getDataQuality(A(), { pageSize: '200' }, tx));
  assert.ok(seenByA.items.some((i) => i.entityId === person.id));
});
