'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const { Person } = require('../src/models');

let tenant;
let otherCompanyId;

before(async () => {
  tenant = await getSeedTenant();
  const [[row]] = await sequelize.query('SELECT id FROM core.companies WHERE id != :companyId LIMIT 1', {
    replacements: { companyId: tenant.companyId },
  });
  otherCompanyId = row ? row.id : '00000000-0000-0000-0000-000000000000';
});

after(async () => {
  await sequelize.close();
});

async function createPerson(transaction, label) {
  return Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `${label} ${uniqueSuffix()}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

test('CORRESPONDENT-CASE-01: cria um financing_case em DRAFT com um proponente PRINCIPAL', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const principal = await createPerson(transaction, 'Proponente');
    const financingCase = await financingCasesService.createFinancingCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
      tenant.userId,
      transaction
    );
    assert.equal(financingCase.status, 'DRAFT');
    assert.equal(financingCase.providerCode, 'sandbox');
    assert.equal(financingCase.applicants.length, 1);
    assert.equal(financingCase.applicants[0].person.id, principal.id);
    assert.equal(financingCase.applicants[0].role, 'PRINCIPAL');
  });
});

test('CORRESPONDENT-CASE-02: aceita um proponente PRINCIPAL + um CO_APPLICANT', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const principal = await createPerson(transaction, 'Principal');
    const co = await createPerson(transaction, 'Co-proponente');
    const financingCase = await financingCasesService.createFinancingCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        applicants: [
          { personId: principal.id, role: 'PRINCIPAL' },
          { personId: co.id, role: 'CO_APPLICANT' },
        ],
      },
      tenant.userId,
      transaction
    );
    assert.equal(financingCase.applicants.length, 2);
  });
});

test('CORRESPONDENT-CASE-03: rejeita criação sem nenhum proponente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => financingCasesService.createFinancingCase({ groupId: tenant.groupId, companyId: tenant.companyId, applicants: [] }, tenant.userId, transaction),
      (err) => err.code === 'FINANCING_CASE_VALIDATION'
    );
  });
});

test('CORRESPONDENT-CASE-04: rejeita criação sem proponente PRINCIPAL (só CO_APPLICANT)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const co = await createPerson(transaction, 'Só co-proponente');
    await assert.rejects(
      () =>
        financingCasesService.createFinancingCase(
          { groupId: tenant.groupId, companyId: tenant.companyId, applicants: [{ personId: co.id, role: 'CO_APPLICANT' }] },
          tenant.userId,
          transaction
        ),
      (err) => err.code === 'FINANCING_CASE_VALIDATION'
    );
  });
});

test('CORRESPONDENT-CASE-05: rejeita personId que não existe (texto livre/id inventado nunca vira proponente)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () =>
        financingCasesService.createFinancingCase(
          { groupId: tenant.groupId, companyId: tenant.companyId, applicants: [{ personId: '00000000-0000-0000-0000-000000000000', role: 'PRINCIPAL' }] },
          tenant.userId,
          transaction
        ),
      (err) => err.code === 'FINANCING_CASE_APPLICANT_NOT_FOUND'
    );
  });
});

test('CORRESPONDENT-CASE-06: rejeita provider desconhecido', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const principal = await createPerson(transaction, 'Provider inválido');
    await assert.rejects(
      () =>
        financingCasesService.createFinancingCase(
          { groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'banco-fantasma', applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
          tenant.userId,
          transaction
        ),
      (err) => err.code === 'FINANCING_CASE_PROVIDER_UNKNOWN'
    );
  });
});

test('CORRESPONDENT-CASE-07: listFinancingCases filtra por status e traz os proponentes populados', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const principal = await createPerson(transaction, 'Listagem');
    await financingCasesService.createFinancingCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
      tenant.userId,
      transaction
    );
    const list = await financingCasesService.listFinancingCases(tenant.groupId, tenant.companyId, transaction, { status: 'DRAFT' });
    assert.ok(list.length >= 1);
    assert.ok(list.every((c) => c.status === 'DRAFT'));
    assert.ok(list[0].applicants.length >= 1);
    assert.ok(list[0].applicants[0].person.legalName);
  });
});

// RLS cross-company — mesmo padrão adversarial de legal.crossCompanyIsolation.test.js: muda o
// contexto de tenant DENTRO da mesma transação para uma empresa DIFERENTE e tenta ler a linha
// da empresa original, direto via SQL (não só confiar na policy existir).
test('CORRESPONDENT-CASE-08: financing_cases e case_applicants — outra empresa não enxerga via SELECT direto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const principal = await createPerson(transaction, 'RLS');
    const financingCase = await financingCasesService.createFinancingCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
      tenant.userId,
      transaction
    );

    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });

    const [caseRows] = await sequelize.query('SELECT id FROM "correspondent"."financing_cases" WHERE id = :id', {
      replacements: { id: financingCase.id },
      transaction,
    });
    assert.equal(caseRows.length, 0, 'empresa diferente não deve conseguir SELECT no financing_case da empresa original');

    const [applicantRows] = await sequelize.query('SELECT id FROM "correspondent"."case_applicants" WHERE financing_case_id = :id', {
      replacements: { id: financingCase.id },
      transaction,
    });
    assert.equal(applicantRows.length, 0, 'empresa diferente não deve conseguir SELECT nos case_applicants da empresa original');
  });
});

test('CORRESPONDENT-CASE-09: getFinancingCase lança NOT_FOUND para id de outra empresa/inexistente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => financingCasesService.getFinancingCase('00000000-0000-0000-0000-000000000000', tenant.groupId, tenant.companyId, transaction),
      (err) => err.code === 'FINANCING_CASE_NOT_FOUND'
    );
  });
});
