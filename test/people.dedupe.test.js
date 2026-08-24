'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('dedup: cria pessoa, tenta duplicata por CPF, espera 409 (allowDuplicate NÃO contorna match forte)', async () => {
  const suffix = uniqueSuffix();
  const taxIdNormalized = `11122233${suffix}`.slice(0, 11).padEnd(11, '0');

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const first = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Pessoa Dedup ${suffix}`, taxIdNormalized },
      tenant.userId,
      transaction
    );
    assert.ok(first.id);

    await assert.rejects(
      () =>
        peopleService.createPerson(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            personType: 'PF',
            legalName: `Pessoa Dedup Duplicada ${suffix}`,
            taxIdNormalized,
          },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'PERSON_DUPLICATE');
        assert.equal(err.details.existingPersonId, first.id);
        return true;
      }
    );

    // UNIQUE(group_id, tax_id_normalized) é restrição de identidade do banco (TAB-0100) — ao
    // contrário do match por contato (médio/fraco), duas pessoas com o mesmo CPF no mesmo grupo
    // nunca são uma duplicata "de negócio" legítima; "allowDuplicate" não pode contornar isso.
    await assert.rejects(
      () =>
        peopleService.createPerson(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            personType: 'PF',
            legalName: `Pessoa Dedup Forçada ${suffix}`,
            taxIdNormalized,
            allowDuplicate: true,
          },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'PERSON_DUPLICATE_TAX_ID');
        return true;
      }
    );

    // allowDuplicate ainda funciona para o match médio (mesmo CPF não informado, contato igual)
    // — cenário coberto pelo próximo teste ("dedup: cria pessoa, tenta duplicata por contato").
  });
});

test('dedup: cria pessoa, tenta duplicata por contato principal (email), espera 409', async () => {
  const suffix = uniqueSuffix();
  const email = `dedup.${suffix}@teste.nayaraone.dev`;

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const first = await peopleService.createPerson(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personType: 'PF',
        legalName: `Pessoa Email ${suffix}`,
        contacts: [{ contactType: 'EMAIL', valueNormalized: email, isPrimary: true }],
      },
      tenant.userId,
      transaction
    );
    assert.ok(first.id);

    await assert.rejects(
      () =>
        peopleService.createPerson(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            personType: 'PF',
            legalName: `Pessoa Email Duplicada ${suffix}`,
            contacts: [{ contactType: 'EMAIL', valueNormalized: email, isPrimary: true }],
          },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'PERSON_DUPLICATE');
        return true;
      }
    );
  });
});

test('dedup: pessoas sem documento/contato em comum não conflitam', async () => {
  const suffix = uniqueSuffix();

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const first = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Pessoa Sem Conflito A ${suffix}` },
      tenant.userId,
      transaction
    );
    const second = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Pessoa Sem Conflito B ${suffix}` },
      tenant.userId,
      transaction
    );
    assert.notEqual(first.id, second.id);
  });
});
