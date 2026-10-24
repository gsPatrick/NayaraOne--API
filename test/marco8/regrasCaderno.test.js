'use strict';

// Marco 8 — regras que a Nayara cobra em todo marco: auditoria com antes e depois,
// e o envio só com consentimento (caderno: "Envio exige requirements completos e
// autorização/consentimento aplicável").

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const financingCasesService = require('../../src/features/correspondent/cases/financingCases.service');
const submissionsService = require('../../src/features/correspondent/cases/submissions.service');
const { Person, AuditLog, ProviderSubmission } = require('../../src/models');

const ANTES_CRIACAO = 'Não existia (registro criado nesta ação)';

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function criarPessoa(transaction) {
  return Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `Proponente M8 ${uniqueSuffix()}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

test('M8-AUD-01: criar caso grava antes (não existia) e depois (o caso)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const pessoa = await criarPessoa(transaction);
    const financingCase = await financingCasesService.createFinancingCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        applicants: [{ personId: pessoa.id, role: 'PRINCIPAL' }],
      },
      tenant.userId,
      transaction
    );
    const row = await AuditLog.findOne({
      where: { action: 'correspondent.financing_case.created', entityId: financingCase.id },
      transaction,
    });
    assert.ok(row, 'audit_log da criação');
    assert.ok(JSON.stringify(row.beforeJson).includes(ANTES_CRIACAO));
    assert.equal(row.afterJson.id, financingCase.id);
    assert.equal(row.afterJson.status, 'DRAFT');
  });
});

test('M8-CONS-01: envio sem consentimento é recusado e não cria submissão', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const pessoa = await criarPessoa(transaction);
    const financingCase = await financingCasesService.createFinancingCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        applicants: [{ personId: pessoa.id, role: 'PRINCIPAL' }],
      },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => submissionsService.requestSubmission(
        financingCase.id,
        { amount: 200000 },
        tenant.userId,
        tenant.groupId,
        tenant.companyId,
        transaction
      ),
      (err) => err.code === 'SUBMISSION_CONSENT_REQUIRED' && /consentimento/.test(err.message)
    );
    const rows = await ProviderSubmission.findAll({ where: { financingCaseId: financingCase.id }, transaction });
    assert.equal(rows.length, 0);
  });
});

test('M8-CONS-02: envio com consentimento grava o fato e a auditoria de antes/depois', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const pessoa = await criarPessoa(transaction);
    const financingCase = await financingCasesService.createFinancingCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        applicants: [{ personId: pessoa.id, role: 'PRINCIPAL' }],
      },
      tenant.userId,
      transaction
    );
    const submission = await submissionsService.submitFinancingCase(
      financingCase.id,
      { amount: 200000, consent: true },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    assert.equal(submission.status, 'SUBMITTED');
    assert.equal(submission.requestSnapshot.consent, true);
    const row = await AuditLog.findOne({
      where: { action: 'correspondent.submission.submitted', entityId: financingCase.id },
      transaction,
    });
    assert.ok(row, 'audit_log da submissão');
    assert.equal(row.beforeJson.status, 'READY_TO_SUBMIT');
    assert.equal(row.afterJson.status, 'SUBMITTED');
    assert.equal(row.afterJson.externalCaseId, submission.externalCaseId);
  });
});
