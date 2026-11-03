'use strict';

// Marco 8 — validação humana fecha o checklist, e o envio leva só o necessário.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const financingCasesService = require('../../src/features/correspondent/cases/financingCases.service');
const caseDocumentsService = require('../../src/features/correspondent/cases/caseDocuments.service');
const submissionsService = require('../../src/features/correspondent/cases/submissions.service');
const nayService = require('../../src/features/correspondent/correspondentNay.service');
const { Person, File, FinancingCase } = require('../../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function base(transaction) {
  const pessoa = await Person.create(
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
  const financingCase = await financingCasesService.createFinancingCase(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      applicants: [{ personId: pessoa.id, role: 'PRINCIPAL' }],
    },
    tenant.userId,
    transaction
  );
  const requirement = await caseDocumentsService.createRequirement(
    financingCase.id,
    { documentType: 'RG_CPF' },
    tenant.userId,
    { groupId: tenant.groupId, companyId: tenant.companyId },
    transaction
  );
  const file = await File.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      fileName: `rg-${uniqueSuffix()}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      storageKey: `test/${uniqueSuffix()}.pdf`,
      uploadedByUserId: tenant.userId,
    },
    { transaction }
  );
  return { financingCase, requirement, file };
}

test('M8-VAL-01: documento enviado sem validação humana não libera o envio', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { financingCase, requirement, file } = await base(transaction);
    await financingCase.reload({ transaction });
    assert.equal(financingCase.status, 'DOCUMENTS_PENDING');

    await caseDocumentsService.uploadDocument(
      financingCase.id,
      requirement.id,
      { fileId: file.id },
      tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId },
      transaction
    );
    await assert.rejects(
      () => submissionsService.requestSubmission(
        financingCase.id,
        { amount: 200000, consent: true },
        tenant.userId,
        tenant.groupId,
        tenant.companyId,
        transaction
      ),
      (err) => err.code === 'SUBMISSION_CHECKLIST_INCOMPLETE'
    );
  });
});

test('M8-VAL-02: validação humana deixa o caso pronto e o snapshot não leva o arquivo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { financingCase, requirement, file } = await base(transaction);
    await caseDocumentsService.uploadDocument(
      financingCase.id,
      requirement.id,
      { fileId: file.id },
      tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId },
      transaction
    );
    await caseDocumentsService.validateRequirement(
      financingCase.id,
      requirement.id,
      tenant.userId,
      { groupId: tenant.groupId, companyId: tenant.companyId },
      transaction, { manualFields: { taxId: '52998224725', name: 'Fulano de Tal', income: 5000, accountNumber: '12345-6' } });
    const atual = await FinancingCase.findByPk(financingCase.id, { transaction });
    assert.equal(atual.status, 'READY_TO_SUBMIT');

    const submission = await submissionsService.submitFinancingCase(
      financingCase.id,
      { amount: 200000, consent: true },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    assert.equal(submission.status, 'SUBMITTED');
    assert.deepEqual(Object.keys(submission.requestSnapshot).sort(), ['amount', 'applicants', 'consent', 'documents', 'eligibilityRuleVersionId', 'financingCaseId', 'idempotencyKey', 'providerCode', 'simulation']);
    assert.equal(JSON.stringify(submission.requestSnapshot).includes(file.id), false);
  });
});

test('M8-VAL-03: a NAY não altera o caso nem valida documento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { financingCase } = await base(transaction);
    await financingCase.reload({ transaction });
    const antes = financingCase.status;
    const sinal = await nayService.checkStalledCases(tenant.groupId, tenant.companyId, { thresholdDays: 1 }, transaction);
    assert.equal(sinal.decisionsMade.length, 0);
    assert.match(sinal.disclaimer, /Não decide/);
    const depois = await FinancingCase.findByPk(financingCase.id, { transaction });
    assert.equal(depois.status, antes);
    assert.equal(typeof nayService.validateRequirement, 'undefined');
    assert.equal(typeof nayService.uploadDocument, 'undefined');
    assert.equal(typeof nayService.submitFinancingCase, 'undefined');
  });
});
