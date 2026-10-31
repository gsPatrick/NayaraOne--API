'use strict';

// M9-D912 — os pontos de exclusão, anonimização e união: DELETE manual, pedido de exclusão do titular, escopo dinâmico (contrato criado depois do hold), merge destrutivo e a
// decisão MERGED da fila de M9-D805. Cada teste roda numa transação desfeita (rollback). Banco descartável (ver m9d805.deteccao.test.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d805Env');
const holds = require('../../../src/features/core-governance/data-quality/legalHold.service');
const guard = require('../../../src/features/core-governance/data-quality/legalHold.guard');
const mergeService = require('../../../src/features/core-governance/data-quality/merge.service');
const personService = require('../../../src/features/people/person.service');
const contactsService = require('../../../src/features/people/personContacts.service');
const documentsService = require('../../../src/features/people/personDocuments.service');
const rolesService = require('../../../src/features/people/personRoles.service');
const propertiesService = require('../../../src/features/properties/properties.service');
const mediaService = require('../../../src/features/properties/propertyMedia.service');
const propertyDocsService = require('../../../src/features/properties/propertyDocuments.service');
const ownersService = require('../../../src/features/properties/propertyOwners.service');
const guaranteesService = require('../../../src/features/legal/guarantees.service');
const { mergePersons } = require('../../../src/features/people/personMerge.service');
const { mergeProperties } = require('../../../src/features/properties/propertyMerge.service');
const wiring = require('../../../src/features/core-governance/data-quality/legalHold.wiring');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); wiring.install(); } });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const run = (fn) => env.withRollbackTenantTransaction(A(), fn);
const actor = () => ({ userId: A().userId, roles: [] });
let n = 0;
const hold = (tx, scope) => holds.create(A(), actor(), { code: `QA912-D-${Date.now()}-${n += 1}`, reason: 'QA-M9 processo', matter_ref: '0007777-11.2026.8.26.0001', scope }, tx);
const blocked = async (promise) => assert.rejects(promise, (err) => { assert.deepEqual([err.statusCode || err.status, err.code], [409, 'GOV_HOLD_BLOCKS_DISPOSAL']); return true; });

test('m9d912 exclusão manual de registro em hold é recusada em todas as rotas de exclusão de pessoa e de imóvel; fora do hold segue normal', { skip: skip() }, async () => {
  await run(async (tx) => {
    const person = await env.person(A(), tx); const free = await env.person(A(), tx);
    const property = await env.property(A(), tx); const freeProperty = await env.property(A(), tx);
    await hold(tx, [{ type: 'PERSON', id: person.id }, { type: 'ENTITY', entity_type: 'PROPERTY', id: property.id }]);
    const noId = '00000000-0000-4000-8000-0000000000cc';
    await blocked(personService.deletePerson(person.id, A().userId, tx));
    await blocked(contactsService.deleteContact(person.id, noId, A().userId, tx));
    await blocked(documentsService.deleteDocument(person.id, noId, A().userId, tx));
    await blocked(rolesService.deleteRole(person.id, noId, A().userId, tx));
    await blocked(propertiesService.deleteProperty(property.id, A().userId, tx));
    await blocked(mediaService.deleteMedia(property.id, noId, tx));
    await blocked(propertyDocsService.deleteDocument(property.id, noId, tx));
    await blocked(ownersService.deleteOwner(property.id, noId, A().userId, tx));
    assert.equal((await env.query('SELECT deleted_at FROM people.persons WHERE id = :id', { id: person.id }, tx))[0].deleted_at, null, 'a pessoa em hold continua');
    assert.equal((await env.query('SELECT deleted_at FROM real_estate.properties WHERE id = :id', { id: property.id }, tx))[0].deleted_at, null);
    assert.deepEqual(await personService.deletePerson(free.id, A().userId, tx), { id: free.id });
    assert.deepEqual(await propertiesService.deleteProperty(freeProperty.id, A().userId, tx), { id: freeProperty.id });
  });
});

test('m9d912 garantia de contrato em hold não se apaga', { skip: skip() }, async () => {
  await run(async (tx) => {
    const contractId = (await env.query(`INSERT INTO legal.contracts (id, group_id, company_id, contract_type, contract_number, status, total_value, created_by, updated_by) VALUES (gen_random_uuid(), :g, :c, 'SALE', :n, 'DRAFT', 10, :u, :u) RETURNING id`,
      { g: A().groupId, c: A().companyId, n: `QA912-G-${Date.now()}`, u: A().userId }, tx))[0].id;
    const guarantee = await guaranteesService.createGuarantee(contractId, { guaranteeType: 'DEPOSIT', endsAt: '2031-01-01', value: 100 }, A().userId, tx);
    await hold(tx, [{ type: 'CONTRACT', id: contractId }]);
    await blocked(guaranteesService.deleteGuarantee(guarantee.id, A().userId, tx));
  });
});

test('m9d912 pedido de exclusão do titular sobre dado em hold é recusado (pessoa, contrato, processo ou arquivo dela) e o dado segue', { skip: skip() }, async () => {
  await run(async (tx) => {
    const holder = await env.person(A(), tx); const viaContract = await env.person(A(), tx); const free = await env.person(A(), tx);
    const contract = (await env.query(`INSERT INTO legal.contracts (id, group_id, company_id, contract_type, contract_number, status, total_value, created_by, updated_by) VALUES (gen_random_uuid(), :g, :c, 'SALE', :n, 'DRAFT', 10, :u, :u) RETURNING id`,
      { g: A().groupId, c: A().companyId, n: `QA912-T-${Date.now()}`, u: A().userId }, tx))[0].id;
    await env.query("INSERT INTO legal.contract_parties (id, group_id, company_id, contract_id, person_id, party_role) VALUES (gen_random_uuid(), :g, :c, :k, :p, 'BUYER') RETURNING id", { g: A().groupId, c: A().companyId, k: contract, p: viaContract.id }, tx);
    await hold(tx, [{ type: 'PERSON', id: holder.id }, { type: 'ENTITY', entity_type: 'CONTRACT', id: contract }]);
    await assert.rejects(guard.assertPersonErasable(holder.id, tx), /Este registro está sob retenção legal e não pode ser apagado ou anonimizado\./);
    await blocked(guard.assertPersonErasable(viaContract.id, tx)); // o contrato dela está em hold
    await guard.assertPersonErasable(free.id, tx);
    await blocked(personService.deletePerson(viaContract.id, A().userId, tx));
    assert.equal((await env.query('SELECT deleted_at FROM people.persons WHERE id = :id', { id: viaContract.id }, tx))[0].deleted_at, null, 'o dado segue em hold');
  });
});

test('m9d912 hold da pessoa cobre contrato criado após o hold', { skip: skip() }, async () => {
  await run(async (tx) => {
    const person = await env.person(A(), tx);
    const created = await hold(tx, [{ type: 'PERSON', id: person.id }]);
    const contract = (await env.query(`INSERT INTO legal.contracts (id, group_id, company_id, contract_type, contract_number, status, total_value, created_by, updated_by) VALUES (gen_random_uuid(), :g, :c, 'SALE', :n, 'DRAFT', 10, :u, :u) RETURNING id`,
      { g: A().groupId, c: A().companyId, n: `QA912-N-${Date.now()}`, u: A().userId }, tx))[0].id;
    assert.deepEqual(await guard.heldIds('CONTRACT', [contract], { tenant: A(), transaction: tx }), [], 'ainda não é parte da pessoa');
    await env.query("INSERT INTO legal.contract_parties (id, group_id, company_id, contract_id, person_id, party_role) VALUES (gen_random_uuid(), :g, :c, :k, :p, 'BUYER') RETURNING id", { g: A().groupId, c: A().companyId, k: contract, p: person.id }, tx);
    await blocked(guard.assertNotOnHold('CONTRACT', contract, tx));
    const targets = await env.query("SELECT origin FROM governance.legal_hold_targets WHERE hold_id = :id AND entity_type = 'CONTRACT' AND entity_id = :c", { id: created.id, c: contract }, tx);
    assert.deepEqual(targets.map((t) => t.origin), ['DERIVED'], 'o alvo foi materializado pelo serviço quando o contrato caiu no escopo');
  });
});

test('m9d912 merge destrutivo recusado em hold (pessoa e imóvel) e o cadastro livre segue podendo ser unido', { skip: skip() }, async () => {
  await run(async (tx) => {
    const a = await env.person(A(), tx); const b = await env.person(A(), tx); const c = await env.person(A(), tx);
    const p1 = await env.property(A(), tx); const p2 = await env.property(A(), tx);
    await hold(tx, [{ type: 'PERSON', id: b.id }, { type: 'ENTITY', entity_type: 'PROPERTY', id: p2.id }]);
    await blocked(mergePersons(a.id, b.id, A().userId, tx)); // o absorvido está em hold
    await blocked(mergePersons(b.id, a.id, A().userId, tx)); // o sobrevivente está em hold
    await blocked(mergeProperties(p1.id, p2.id, A().userId, tx));
    await mergePersons(a.id, c.id, A().userId, tx);
    assert.equal((await env.query('SELECT status FROM people.persons WHERE id = :id', { id: c.id }, tx))[0].status, 'MERGED', 'o cadastro livre foi unido');
  });
});

test('m9d912 decisão MERGED de M9-D805 sobre registro em hold devolve 409 e a fila não muda; DISMISSED continua possível', { skip: skip() }, async () => {
  await run(async (tx) => {
    const first = await env.person(A(), tx, { legalName: 'Maria Souza Prado' }); const second = await env.person(A(), tx, { legalName: 'Maria Souza Prado' });
    const item = await env.candidate(A(), tx, 'PERSON', first.id, second.id);
    const { actor: steward } = await env.steward(A(), tx);
    await hold(tx, [{ type: 'ENTITY', entity_type: 'PERSON', id: second.id }]);
    const survivor = item.primary_id;
    await blocked(mergeService.decide(A(), steward, item.id, { decision: 'MERGED', survivorId: survivor, note: 'Mesma pessoa.' }, tx));
    const row = (await env.queueRows(A(), tx, 'id = :id', { id: item.id }))[0];
    assert.notEqual(row.status, 'MERGED', 'a fila não registrou a união');
    assert.notEqual((await env.query('SELECT status FROM people.persons WHERE id = :id', { id: second.id }, tx))[0].status, 'MERGED', 'o cadastro em hold não foi absorvido');
    const dismissed = await mergeService.decide(A(), steward, item.id, { decision: 'DISMISSED', note: 'Não é a mesma pessoa.' }, tx);
    assert.equal(dismissed.status, 'DISMISSED', 'descartar o par não mexe no cadastro e segue possível');
  });
});
