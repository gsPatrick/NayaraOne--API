'use strict';

// M9-D806 — nota de qualidade por cadastro: fórmula, arredondamento, aplicabilidade das regras. Banco descartável:
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d806.score.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d806Env');
const { evaluateEntity } = require('../../../src/features/core-governance/data-quality/quality.evaluate');
const { computeScore } = require('../../../src/features/core-governance/data-quality/quality.score');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const run = (fn) => env.withRollbackTenantTransaction(tenants.A, fn);
const evaluate = (tx, type, id) => evaluateEntity(A(), type, id, tx, { actorUserId: A().userId });

test('m9d806 arredondamento half-even a 2 casas e score 0 sem regra aplicável', () => {
  assert.equal(computeScore(75, 100), 75);
  assert.equal(computeScore(1, 32), 3.12, '3,125 vai para o par mais próximo (3,12)');
  assert.equal(computeScore(3, 32), 9.38, '9,375 vai para o par mais próximo (9,38)');
  assert.equal(computeScore(2, 3), 66.67);
  assert.equal(computeScore(0, 0), 0);
});

test('m9d806 score 75,00 do exemplo e 90,00 depois de corrigir o endereço', { skip: skip() }, async () => {
  await run(async (tx) => {
    const person = await env.fullPerson(A(), tx, {}, { address: false, birth: false });
    const first = await evaluate(tx, 'PERSON', person.id);
    assert.equal(first.score, 75);
    assert.deepEqual(first.failed.sort(), ['PERSON_ADDRESS_COMPLETE', 'PERSON_BIRTH_COHERENT']);
    assert.equal((await env.issues(A(), person.id, tx, "status = 'OPEN'")).length, 2);
    await env.PersonAddress.create({ groupId: A().groupId, companyId: A().companyId, personId: person.id, ...env.FULL_ADDRESS, isCurrent: true, createdBy: A().userId, updatedBy: A().userId }, { transaction: tx });
    const second = await evaluate(tx, 'PERSON', person.id);
    assert.equal(second.score, 90);
    const [score] = await env.query('SELECT score, applicable_weight FROM governance.quality_scores WHERE entity_id = :id', { id: person.id }, tx);
    assert.deepEqual([Number(score.score), score.applicable_weight], [90, 100]);
  });
});

test('m9d806 regra inaplicável sai do denominador: nome com número só pesa para pessoa física', { skip: skip() }, async () => {
  await run(async (tx) => {
    const legal = await env.fullPerson(A(), tx, { personType: 'PJ', legalName: 'Empresa 123 Ltda', taxIdNormalized: env.cnpj() });
    const natural = await env.fullPerson(A(), tx, { personType: 'PF', legalName: 'Maria 3 Souza' });
    const forLegal = await evaluate(tx, 'PERSON', legal.id);
    const forNatural = await evaluate(tx, 'PERSON', natural.id);
    assert.equal(forLegal.applicableWeight, 95, 'a regra do nome sai do denominador da pessoa jurídica');
    assert.equal(forLegal.score, 100);
    assert.equal(forNatural.applicableWeight, 100);
    assert.equal(forNatural.score, 95);
    assert.deepEqual(forNatural.failed, ['PERSON_NAME_NO_DIGITS']);
  });
});

test('m9d806 completude e consistência cobertas para PERSON, PROPERTY e SUPPLIER', { skip: skip() }, async () => {
  await run(async (tx) => {
    const badPerson = await env.fullPerson(A(), tx, { taxIdNormalized: env.invalidCpf(), birthOrFoundationDate: '2999-01-01' }, { contact: false, role: false });
    const person = await evaluate(tx, 'PERSON', badPerson.id);
    assert.deepEqual(person.failed.sort(), ['PERSON_BIRTH_COHERENT', 'PERSON_CONTACT_PRESENT', 'PERSON_ROLE_DEFINED', 'PERSON_TAX_ID_VALID']);
    const property = await env.fullProperty(A(), tx, { registryNumber: null, areaTotalM2: 0 }, { owner: false, media: false, offer: false });
    assert.deepEqual((await evaluate(tx, 'PROPERTY', property.id)).failed.sort(), ['PROPERTY_AREA_POSITIVE', 'PROPERTY_MEDIA_MIN', 'PROPERTY_OWNER_LINKED', 'PROPERTY_PURPOSE_DEFINED', 'PROPERTY_REGISTRY_PRESENT']);
    const supplier = await env.fullSupplier(A(), tx, { taxIdNormalized: env.invalidCnpj() }, { qualification: false, category: null });
    const result = await evaluate(tx, 'SUPPLIER', supplier.id);
    assert.deepEqual(result.failed.sort(), ['SUPPLIER_CATEGORY_DEFINED', 'SUPPLIER_QUALIFICATION_VALID', 'SUPPLIER_TAX_ID_VALID']);
    const complete = await evaluate(tx, 'SUPPLIER', (await env.fullSupplier(A(), tx)).id);
    assert.equal(complete.score, 100);
    assert.equal((await evaluate(tx, 'PROPERTY', (await env.fullProperty(A(), tx)).id)).score, 100);
  });
});

test('m9d806 regra com applies_when falso sai do denominador (categoria que não exige qualificação)', { skip: skip() }, async () => {
  await run(async (tx) => {
    const supplier = await env.fullSupplier(A(), tx, {}, { qualification: false, category: 'SERVICOS' });
    const required = await evaluate(tx, 'SUPPLIER', supplier.id);
    assert.deepEqual([required.score, required.applicableWeight], [85, 100], 'categoria exige qualificação e o fornecedor não tem');
    await upsertSetting('governanca.dados.qualidade.categorias_qualificacao', 'OBRAS', A(), A().userId, tx);
    const notRequired = await evaluate(tx, 'SUPPLIER', supplier.id);
    assert.deepEqual([notRequired.score, notRequired.applicableWeight], [100, 85]);
    assert.deepEqual((await env.issues(A(), supplier.id, tx, "status = 'OPEN'")), [], 'a issue da regra inaplicável fecha');
  });
});

test('m9d806 pesos e regras desligadas vêm dos parâmetros do administrador', { skip: skip() }, async () => {
  await run(async (tx) => {
    const person = await env.fullPerson(A(), tx, {}, { address: false });
    await upsertSetting('governanca.dados.qualidade.pesos', 'PERSON_ADDRESS_COMPLETE=40', A(), A().userId, tx);
    const heavy = await evaluate(tx, 'PERSON', person.id);
    assert.deepEqual([heavy.passedWeight, heavy.applicableWeight, heavy.score], [85, 125, 68]);
    await upsertSetting('governanca.dados.qualidade.regras_desativadas', 'PERSON_ADDRESS_COMPLETE', A(), A().userId, tx);
    const off = await evaluate(tx, 'PERSON', person.id);
    assert.deepEqual([off.applicableWeight, off.score], [85, 100]);
  });
});
