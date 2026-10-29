'use strict';

// M9-D807 — proprietário do imóvel e conta de destino do repasse: campos críticos com evidência. Banco descartável (ver m9d807.servico.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d807Env');
const ownersService = require('../../../src/features/properties/propertyOwners.service');
const { resolveRepasseDestination } = require('../../../src/features/finance/ownerRepasseDestination.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const run = (fn) => env.withRollbackTenantTransaction(tenants.A, fn);
const fail = (promise) => promise.then(() => null, (err) => err);
const EVIDENCE = { source: 'OTHER', note: 'Escritura nova apresentada ao escritório.' };

test('m9d807 mudar o proprietário do imóvel exige evidência e grava o campo owner', { skip: skip() }, async () => {
  await run(async (tx) => {
    const property = await env.property(A(), tx);
    const person = await env.person(A(), tx);
    const link = await ownersService.createOwner(property.id, { personId: person.id, ownershipPercent: 100 }, A().userId, tx);
    const same = await ownersService.updateOwner(property.id, link.id, { ownershipPercent: 100 }, A().userId, tx);
    assert.equal(Number(same.ownershipPercent), 100, 'mesmo valor: sem evidência');
    const err = await fail(ownersService.updateOwner(property.id, link.id, { ownershipPercent: 50 }, A().userId, tx));
    assert.equal(err.code, 'GOV_EVIDENCE_REQUIRED');
    const changed = await ownersService.updateOwner(property.id, link.id, { ownershipPercent: 50, changeEvidence: EVIDENCE }, A().userId, tx);
    assert.equal(Number(changed.ownershipPercent), 50);
    assert.deepEqual((await env.evidenceRows(link.id, tx)).map((r) => [r.entity_type, r.field]), [['PROPERTY_OWNER', 'owner']]);
    const del = await fail(ownersService.deleteOwner(property.id, link.id, A().userId, tx));
    assert.equal(del.code, 'GOV_EVIDENCE_REQUIRED');
    await ownersService.deleteOwner(property.id, link.id, A().userId, tx, EVIDENCE);
    assert.equal((await env.evidenceRows(link.id, tx)).length, 2);
  });
});

test('m9d807 trocar a conta de destino de um repasse que já tem conta exige evidência', { skip: skip() }, async () => {
  await run(async (tx) => {
    const repasse = { id: env.randomUUID(), groupId: A().groupId, companyId: A().companyId, bankAccountId: env.randomUUID() };
    const other = env.randomUUID();
    const first = await resolveRepasseDestination({ ...repasse, bankAccountId: null }, { bankAccountId: other }, A().userId, tx);
    assert.equal(first.bankAccountId, other, 'primeira conta do repasse: não é troca');
    const same = await resolveRepasseDestination(repasse, {}, A().userId, tx);
    assert.equal(same.bankAccountId, repasse.bankAccountId, 'sem conta no corpo, vale a fixada');
    const err = await fail(resolveRepasseDestination(repasse, { bankAccountId: other }, A().userId, tx));
    assert.equal(err.code, 'GOV_EVIDENCE_REQUIRED');
    const ok = await resolveRepasseDestination(repasse, { bankAccountId: other, changeEvidence: EVIDENCE }, A().userId, tx);
    assert.equal(ok.bankAccountId, other);
    await ok.record();
    assert.deepEqual((await env.evidenceRows(repasse.id, tx)).map((r) => [r.entity_type, r.field]), [['REPASSE', 'bankAccountId']]);
  });
});
