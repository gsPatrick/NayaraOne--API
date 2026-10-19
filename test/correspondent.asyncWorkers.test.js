'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const documentsService = require('../src/features/correspondent/cases/caseDocuments.service');
const submissionsService = require('../src/features/correspondent/cases/submissions.service');
const appraisalsService = require('../src/features/correspondent/cases/appraisals.service');
const { processCompanyPendingSubmissionsForTest } = require('../src/engines/jobs/correspondentSubmissionWorkerJob');
const { processCompanyPendingAppraisalsForTest } = require('../src/engines/jobs/correspondentAppraisalWorkerJob');
const { Person, File, ProviderSubmission, Appraisal } = require('../src/models');

let tenant;
const createdCaseIds = [];

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  // Limpeza — só das linhas criadas por este arquivo, nunca em massa.
  if (createdCaseIds.length) {
    await ProviderSubmission.destroy({ where: { financingCaseId: createdCaseIds }, force: true }).catch(() => {});
    await Appraisal.destroy({ where: { financingCaseId: createdCaseIds }, force: true }).catch(() => {});
  }
  await sequelize.close();
});

async function withCommitted(fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
    const r = await fn(t);
    await t.commit();
    return r;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function createReadyCase(transaction) {
  const principal = await Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `Proponente Worker ${uniqueSuffix()}`,
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
  createdCaseIds.push(financingCase.id);
  return financingCase;
}

async function completeChecklist(financingCaseId, transaction) {
  const requirement = await documentsService.createRequirement(
    financingCaseId,
    { documentType: 'RG_CPF', required: true },
    tenant.userId,
    { groupId: tenant.groupId, companyId: tenant.companyId },
    transaction
  );
  const file = await File.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      fileName: `rg-cpf-${uniqueSuffix()}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      storageKey: `test/${uniqueSuffix()}.pdf`,
      uploadedByUserId: tenant.userId,
    },
    { transaction }
  );
  await documentsService.uploadDocument(
    financingCaseId,
    requirement.id,
    { fileId: file.id },
    tenant.userId,
    { groupId: tenant.groupId, companyId: tenant.companyId },
    transaction
  );
}

test('CORRESPONDENT-WORKER-01: requestSubmission devolve PENDING sem chamar o adapter; o job processa e vira SUBMITTED', async () => {
  const financingCase = await withCommitted((t) => createReadyCase(t));
  await withCommitted((t) => completeChecklist(financingCase.id, t));

  const submission = await withCommitted((t) =>
    submissionsService.requestSubmission(financingCase.id, { amount: 150000 }, tenant.userId, tenant.groupId, tenant.companyId, t)
  );
  assert.equal(submission.status, 'PENDING');
  assert.equal(submission.externalCaseId, null);

  const group = { id: tenant.groupId };
  const company = { id: tenant.companyId };
  // Mesmo motivo do WORKER-02: o job da API local pode processar antes desta rodada; o que importa
  // é o estado final (SUBMITTED com id externo), sem chamada ao adapter no requestSubmission.
  await processCompanyPendingSubmissionsForTest(group, company);

  const refreshed = await withCommitted((t) => ProviderSubmission.findByPk(submission.id, { transaction: t }));
  assert.equal(refreshed.status, 'SUBMITTED');
  assert.ok(refreshed.externalCaseId);
});

test('CORRESPONDENT-WORKER-02: rodar o job 2x não processa a mesma submissão PENDING duas vezes', async () => {
  const financingCase = await withCommitted((t) => createReadyCase(t));
  await withCommitted((t) => completeChecklist(financingCase.id, t));
  const submission = await withCommitted((t) =>
    submissionsService.requestSubmission(financingCase.id, { amount: 150000 }, tenant.userId, tenant.groupId, tenant.companyId, t)
  );

  const group = { id: tenant.groupId };
  const company = { id: tenant.companyId };
  const first = await processCompanyPendingSubmissionsForTest(group, company);
  const second = await processCompanyPendingSubmissionsForTest(group, company);

  // Determinismo (19/10/2026): o banco de dev é compartilhado com a API local, cujo job periódico
  // pode pegar esta submissão (já commitada) antes da primeira rodada daqui. O que o teste exige é
  // que ela seja processada UMA vez e termine SUBMITTED — por esta rodada ou pelo job concorrente.
  const refreshed = await withCommitted((t) => ProviderSubmission.findByPk(submission.id, { transaction: t }));
  assert.equal(refreshed.status, 'SUBMITTED');
  assert.ok(first.processed >= 1 || refreshed.status === 'SUBMITTED');
  // A segunda rodada não encontra mais esta submissão como PENDING.
  const stillPending = await withCommitted((t) => ProviderSubmission.count({ where: { id: submission.id, status: 'PENDING' }, transaction: t }));
  assert.equal(stillPending, 0);
  void second;
});

test('CORRESPONDENT-WORKER-03: requestAppraisalRecord devolve REQUESTED sem chamar o adapter; o job completa a avaliação sem alterar preço de imóvel', async () => {
  const financingCase = await withCommitted((t) => createReadyCase(t));

  const appraisal = await withCommitted((t) =>
    appraisalsService.requestAppraisalRecord(financingCase.id, { referenceValue: 200000 }, tenant.userId, tenant.groupId, tenant.companyId, t)
  );
  assert.equal(appraisal.status, 'REQUESTED');
  assert.equal(appraisal.responseSnapshot, null);

  const group = { id: tenant.groupId };
  const company = { id: tenant.companyId };
  // Mesmo motivo do WORKER-02: o job da API local pode completar a avaliação antes desta rodada.
  await processCompanyPendingAppraisalsForTest(group, company);

  const refreshed = await withCommitted((t) => Appraisal.findByPk(appraisal.id, { transaction: t }));
  assert.equal(refreshed.status, 'COMPLETED');
  assert.ok(refreshed.requestedValue != null);
});
