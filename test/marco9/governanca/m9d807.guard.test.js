'use strict';

// M9-D807 — o guard assertEvidenceForCriticalChange e a lista de campos críticos configurável. Banco descartável (ver m9d807.servico.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d807Env');
const guard = require('../../../src/features/core-governance/data-quality/evidence.guard');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const bankAccountsService = require('../../../src/modules/finance/application/services/bank-accounts.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const run = (fn) => env.withRollbackTenantTransaction(tenants.A, fn);
const fail = (promise) => promise.then(() => null, (err) => err);
const CPF_A = env.cpf();
const CPF_B = env.cpf();
const entityOf = (type, row, current) => ({ type, id: row.id, groupId: A().groupId, companyId: A().companyId, current });

test('m9d807 o guard recusa alteração vinda de merge sem evidência dos campos conflitantes', { skip: skip() }, async () => {
  await run(async (tx) => {
    const survivor = await env.person(A(), tx, { taxIdNormalized: CPF_A });
    const entity = entityOf('PERSON', survivor, { taxIdNormalized: CPF_A, legalName: survivor.legalName, preferredName: 'A' });
    const ctx = { transaction: tx, actorUserId: A().userId };
    const conflict = { taxIdNormalized: CPF_B, preferredName: 'B' };
    const err = await fail(guard.assertEvidenceForCriticalChange(entity, conflict, undefined, ctx));
    assert.equal(err.code, 'GOV_EVIDENCE_REQUIRED');
    const ok = await guard.assertEvidenceForCriticalChange(entity, conflict, { source: 'OTHER', note: 'Escolha do steward na união.' }, ctx);
    assert.deepEqual(ok.changes.map((c) => c.field), ['taxIdNormalized'], 'só o campo crítico entra; preferredName não');
    const none = await guard.assertEvidenceForCriticalChange(entity, { preferredName: 'B' }, undefined, ctx);
    assert.deepEqual(none.changes, []);
  });
});

test('m9d807 SYSTEM_IMPORT vindo de rota HTTP é recusado e do importContext é aceito', { skip: skip() }, async () => {
  await run(async (tx) => {
    const person = await env.person(A(), tx, { taxIdNormalized: CPF_A });
    const entity = entityOf('PERSON', person, { taxIdNormalized: CPF_A });
    const patch = { taxIdNormalized: CPF_B };
    const fromHttp = { transaction: tx, actorUserId: A().userId, importContext: JSON.parse(JSON.stringify({ origin: 'M9-D900' })) };
    assert.equal((await fail(guard.assertEvidenceForCriticalChange(entity, patch, { source: 'SYSTEM_IMPORT' }, fromHttp))).code, 'GOV_EVIDENCE_SOURCE_INVALID');
    assert.equal((await fail(guard.assertEvidenceForCriticalChange(entity, patch, { source: 'SYSTEM_IMPORT' }, { transaction: tx, actorUserId: A().userId }))).code, 'GOV_EVIDENCE_SOURCE_INVALID');
    const context = guard.createImportContext('M9-D900');
    assert.throws(() => JSON.stringify(context), /importContext/, 'o contexto interno não é serializável');
    const ok = await guard.assertEvidenceForCriticalChange(entity, patch, { source: 'SYSTEM_IMPORT' }, { transaction: tx, actorUserId: A().userId, importContext: context });
    assert.equal(ok.evidence.source, 'SYSTEM_IMPORT');
  });
});

test('m9d807 a lista de campos críticos é configurável pelo administrador', { skip: skip() }, async () => {
  await run(async (tx) => {
    const owner = await env.person(A(), tx);
    const account = await env.bankAccount(A(), tx, owner.id);
    assert.deepEqual(await guard.criticalFieldsFor(A(), tx), guard.DEFAULT_CRITICAL_FIELDS.split(',').map((v) => v.trim()), 'padrão do item 3.1');
    await upsertSetting('governanca.dados.campos_criticos', 'PERSON.taxIdNormalized', A(), A().userId, tx);
    const free = await bankAccountsService.updateBankAccount(account.id, { pixKey: 'livre@qa-m9.test' }, A().userId, tx);
    assert.equal(free.pixKey, 'livre@qa-m9.test', 'PIX fora da lista passa sem evidência');
    const err = await fail(upsertSetting('governanca.dados.campos_criticos', 'COISA.campo', A(), A().userId, tx));
    assert.equal(err.code, 'VALIDATION_ERROR');
  });
});

test('m9d807 conta de fornecedor usa os campos críticos de SUPPLIER', { skip: skip() }, async () => {
  await run(async (tx) => {
    const supplier = await env.supplier(A(), tx, { taxIdNormalized: '11222333000181' });
    const account = await env.bankAccount(A(), tx, supplier.id);
    await upsertSetting('governanca.dados.campos_criticos', 'SUPPLIER.pixKey', A(), A().userId, tx);
    const err = await fail(bankAccountsService.updateBankAccount(account.id, { pixKey: 'forn@qa-m9.test' }, A().userId, tx));
    assert.equal(err.code, 'GOV_EVIDENCE_REQUIRED');
    const person = await env.person(A(), tx);
    const personAccount = await env.bankAccount(A(), tx, person.id);
    const free = await bankAccountsService.updateBankAccount(personAccount.id, { pixKey: 'pf@qa-m9.test' }, A().userId, tx);
    assert.equal(free.pixKey, 'pf@qa-m9.test', 'conta de pessoa que não é fornecedor segue a lista de PERSON');
  });
});
