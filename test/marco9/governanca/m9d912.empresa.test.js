'use strict';

// M9-D912 — exclusão de empresa e de grupo: qualquer retenção legal ATIVA na empresa impede apagá-la; liberada a retenção, a exclusão volta a valer.
// Banco descartável; usa retenções com commit real (a checagem do grupo roda em transação própria).
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d912Env');
const companiesService = require('../../../src/features/companies/companies.service');
const companyGuard = require('../../../src/features/core-governance/data-quality/legalHold.companyGuard');

let tenants;
const A = () => tenants.A;
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); await env.resetHolds(A()); env.useRealGuard(); } });
afterEach(async () => { if (env.DISPOSABLE) await env.resetHolds(A()); });
after(async () => { await env.sequelize.close(); });
const blocked = (promise) => assert.rejects(promise, (err) => { assert.deepEqual([err.statusCode || err.status, err.code], [409, 'GOV_HOLD_BLOCKS_DISPOSAL']); return true; });

test('m9d912 empresa com retenção ativa (de qualquer escopo) não pode ser excluída; o contexto da transação é devolvido; liberada, a checagem passa', { skip: env.skip() }, async () => {
  const person = await env.insertPerson(A());
  const hold = await env.createHold(A(), { scope: [{ type: 'PERSON', id: person }] });
  await env.withTx(A(), async (tx) => {
    await blocked(companyGuard.assertCompanyNotOnHold(A().companyId, tx));
    assert.equal((await env.sequelize.query("SELECT current_setting('app.company_id', true) AS id", { type: 'SELECT', transaction: tx }))[0].id, A().companyId, 'o contexto da empresa foi restaurado');
  });
  await blocked(env.withTx(A(), async (tx) => { await companiesService.deleteCompany(A().companyId, A().userId, tx); }));
  const stillThere = (await env.adminQuery('SELECT deleted_at FROM core.companies WHERE id = $1', [A().companyId])).rows[0];
  assert.equal(stillThere.deleted_at, null, 'a empresa em hold continua');
  await env.releaseHold(A(), hold.id);
  await env.withTx(A(), (tx) => companyGuard.assertCompanyNotOnHold(A().companyId, tx));
});

test('m9d912 grupo com empresa em retenção ativa não pode ser excluído; a outra empresa do grupo sem retenção não é alvo', { skip: env.skip() }, async () => {
  const hold = await env.createHold(A(), { scope: [{ type: 'COMPANY' }] });
  await blocked(companyGuard.assertGroupNotOnHold(A().groupId));
  await env.releaseHold(A(), hold.id);
  await companyGuard.assertGroupNotOnHold(A().groupId);
});
