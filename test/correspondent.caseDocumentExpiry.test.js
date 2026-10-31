'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const caseDocumentsService = require('../src/features/correspondent/cases/caseDocuments.service');
const { expireDueDocuments } = require('../src/engines/jobs/caseDocumentExpiryJob');
const { Person, File, CaseRequirement, CaseDocument } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createCaseWithDocument(transaction, expiresAt) {
  const suffix = uniqueSuffix();
  const principal = await Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `Proponente Expiry ${suffix}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
  const financingCase = await financingCasesService.createFinancingCase(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      providerCode: 'sandbox',
      purpose: 'RESIDENCIAL',
      applicants: [{ personId: principal.id, role: 'PRINCIPAL' }],
    },
    tenant.userId,
    transaction
  );
  const requirement = await caseDocumentsService.createRequirement(
    financingCase.id,
    { documentType: 'COMPROVANTE_RENDA' },
    tenant.userId,
    tenant,
    transaction
  );
  const file = await File.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      fileName: `comprovante-${suffix}.pdf`,
      storageKey: `test/${suffix}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 100,
      checksumSha256: `sha-${suffix}`,
      uploadedByUserId: tenant.userId,
    },
    { transaction }
  );
  // O envio recusa validade no passado; o documento que já nasceu vencido é simulado ajustando a data depois do envio.
  const jaVencido = expiresAt && new Date(expiresAt).getTime() < Date.now();
  const document = await caseDocumentsService.uploadDocument(
    financingCase.id,
    requirement.id,
    jaVencido || !expiresAt ? { fileId: file.id } : { fileId: file.id, expiresAt: new Date(expiresAt).toISOString().slice(0, 10) },
    tenant.userId,
    tenant,
    transaction
  );
  if (jaVencido) await CaseDocument.update({ expiresAt }, { where: { id: document.id }, transaction });
  return { financingCase, requirement };
}

test('CORRESPONDENT-DOCEXP-01: documento vencido reabre o requirement automaticamente (EXPIRED + novo PENDING)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { requirement } = await createCaseWithDocument(transaction, past);

    const result = await expireDueDocuments(transaction, new Date());
    assert.equal(result.expired, 1);

    const oldRequirement = await CaseRequirement.findByPk(requirement.id, { transaction });
    assert.equal(oldRequirement.status, 'EXPIRED');

    const newRequirements = await CaseRequirement.findAll({
      where: { financingCaseId: requirement.financingCaseId, documentType: 'COMPROVANTE_RENDA', status: 'PENDING' },
      transaction,
    });
    assert.equal(newRequirements.length, 1);
  });
});

test('CORRESPONDENT-DOCEXP-02: documento sem expiresAt nunca é candidato', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { requirement } = await createCaseWithDocument(transaction, null);
    const result = await expireDueDocuments(transaction, new Date());
    assert.equal(result.expired, 0);
    const reloaded = await CaseRequirement.findByPk(requirement.id, { transaction });
    assert.equal(reloaded.status, 'SUBMITTED');
  });
});

test('CORRESPONDENT-DOCEXP-03: documento com expiresAt no futuro não é candidato ainda', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { requirement } = await createCaseWithDocument(transaction, future);
    const result = await expireDueDocuments(transaction, new Date());
    assert.equal(result.expired, 0);
    const reloaded = await CaseRequirement.findByPk(requirement.id, { transaction });
    assert.equal(reloaded.status, 'SUBMITTED');
  });
});

test('CORRESPONDENT-DOCEXP-04: rodar o job duas vezes não cria um segundo requirement novo (idempotente)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { requirement } = await createCaseWithDocument(transaction, past);

    await expireDueDocuments(transaction, new Date());
    const secondRun = await expireDueDocuments(transaction, new Date());
    assert.equal(secondRun.expired, 0, 'segunda execução não deve achar o mesmo documento como candidato de novo');

    const newRequirements = await CaseRequirement.findAll({
      where: { financingCaseId: requirement.financingCaseId, documentType: 'COMPROVANTE_RENDA', status: 'PENDING' },
      transaction,
    });
    assert.equal(newRequirements.length, 1, 'só um requirement novo deve existir, mesmo rodando o job duas vezes');
  });
});

test('CORRESPONDENT-DOCEXP-05: versão superada (não vigente) nunca é candidata, só a vigente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { financingCase, requirement } = await createCaseWithDocument(transaction, past);

    // Sobe uma nova versão (nunca vencida) para o MESMO requirement antes de rodar o job —
    // a versão vencida vira superada, a vigente não tem expiresAt.
    const file2 = await File.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        fileName: 'comprovante-v2.pdf',
        storageKey: `test/${uniqueSuffix()}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 100,
        checksumSha256: `sha-${uniqueSuffix()}`,
        uploadedByUserId: tenant.userId,
      },
      { transaction }
    );
    await caseDocumentsService.uploadDocument(
      financingCase.id,
      requirement.id,
      { fileId: file2.id },
      tenant.userId,
      tenant,
      transaction
    );

    const result = await expireDueDocuments(transaction, new Date());
    assert.equal(result.expired, 0, 'a versão vencida foi superada antes de vencer de fato — não deve mais ser candidata');

    const current = await CaseDocument.findOne({ where: { requirementId: requirement.id, supersededAt: null }, transaction });
    assert.equal(current.fileId, file2.id);
  });
});
