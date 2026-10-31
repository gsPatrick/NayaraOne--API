'use strict';

/**
 * CRM-TS-002 (Caderno Técnico, Marco 3, seção 19 — testes adversariais): "Merge errado — CPFs
 * conflitantes — Bloqueado." A regra já existe em personMerge.service.js
 * (assertMergeAllowed/PERSON_MERGE_CONFLICT — "ambas preenchidas e diferentes"), e os testes de
 * people.mergeReinforced.test.js cobrem contrato ativo incompatível e outros passos do fluxo,
 * mas nenhum teste isolava especificamente o cenário literal do Caderno: duas pessoas com CPF
 * preenchido e DIFERENTE entre si. Este teste fecha essa lacuna de prova isolada.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const mergeService = require('../src/features/people/personMerge.service');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('CRM-TS-002: merge de duas pessoas com CPF preenchido e DIFERENTE é bloqueado (conflito de identidade)', async () => {
  const suffix = uniqueSuffix();
  const taxIdA = `111${suffix}`.slice(0, 11).padEnd(11, '1');
  const taxIdB = `222${suffix}`.slice(0, 11).padEnd(11, '2');

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const canonical = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Merge CPF A ${suffix}`, taxIdNormalized: taxIdA },
      tenant.userId,
      transaction
    );
    const absorbed = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Merge CPF B ${suffix}`, taxIdNormalized: taxIdB },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => mergeService.mergePersons(canonical.id, absorbed.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'PERSON_MERGE_CONFLICT');
        return true;
      },
      'merge com CPFs diferentes preenchidos em ambas as pessoas precisa ser bloqueado'
    );
  });
});

test('CRM-TS-002 (controle): merge de duas pessoas onde só UMA tem CPF preenchido NÃO é bloqueado por conflito de CPF', async () => {
  const suffix = uniqueSuffix();
  const taxIdA = `333${suffix}`.slice(0, 11).padEnd(11, '3');

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const canonical = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Merge CPF Único A ${suffix}`, taxIdNormalized: taxIdA },
      tenant.userId,
      transaction
    );
    const absorbed = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Merge CPF Único B ${suffix}` },
      tenant.userId,
      transaction
    );

    const result = await mergeService.mergePersons(canonical.id, absorbed.id, tenant.userId, transaction);
    assert.ok(result, 'sem conflito de CPF (uma das partes sem documento), o merge deve prosseguir');
  });
});
