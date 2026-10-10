'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const dailyReportsService = require('../src/features/construction/dailyReports.service');
const peopleService = require('../src/features/people/people.service');
const nayObrasService = require('../src/features/construction/nayObras.service');
const { StageMeasurement, Nonconformity } = require('../src/models');

// Auditoria externa (Nayara) — Marco 6, "NAY Obras" (`nayObras.service.js`). A arquitetura
// "NAY sugere, nunca decide" é deliberada (`decisionsMade: []` hardcoded) — estes testes
// comprovam que os GAPs 1/2/3 foram preenchidos SEM violar essa trava: tudo aqui é sinalização
// textual/estrutural, nenhuma aprovação/pagamento/culpa é executada automaticamente.

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

async function createTestProject(transaction, suffix) {
  return projectsService.createProject(
    withTenant({ name: `Obra NAY QA ${suffix}`, responsibleUserId: tenant.userId }),
    tenant.userId,
    transaction
  );
}

test('GAP 1 — summarizeProject detecta dias úteis sem RDO (missingDailyReportDays > 0)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const project = await createTestProject(transaction, suffix);
    // Nenhum RDO é criado para esta obra — todos os últimos dias úteis devem contar como ausentes.

    const summary = await nayObrasService.summarizeProject(project.id, transaction);

    assert.ok(summary.summary.missingDailyReportDays > 0, 'esperava missingDailyReportDays > 0 sem nenhum RDO registrado');
  });
});

test('GAP 1 — workersWithoutDocuments conta DailyWorker sem documentFileIds', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const project = await createTestProject(transaction, suffix);

    const workerSemDoc = await peopleService.createPerson(
      withTenant({ personType: 'PF', legalName: `Pedreiro NAY QA ${suffix}` }),
      tenant.userId,
      transaction
    );
    const workerComDoc = await peopleService.createPerson(
      withTenant({ personType: 'PF', legalName: `Eletricista NAY QA ${suffix}` }),
      tenant.userId,
      transaction
    );
    const fakeDocId = 'd0a1b2c3-d4e5-46f7-8899-aabbccddeeff';

    await dailyReportsService.createDailyReport(
      project.id,
      withTenant({
        reportDate: '2026-09-20',
        workers: [
          { personId: workerSemDoc.id, role: 'Pedreiro' },
          { personId: workerComDoc.id, role: 'Eletricista', documentFileIds: [fakeDocId] },
        ],
      }),
      tenant.userId,
      transaction
    );

    const summary = await nayObrasService.summarizeProject(project.id, transaction);

    assert.equal(summary.summary.workersWithoutDocuments, 1);
  });
});

test('GAP 2 — visualAnalysisSuggestions aparece no resumo quando não há foto recente de RDO', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const project = await createTestProject(transaction, suffix);

    // RDO sem nenhuma evidência anexada — gera sugestão NO_DAILY_REPORT_PHOTO.
    await dailyReportsService.createDailyReport(
      project.id,
      withTenant({ reportDate: '2026-09-20' }),
      tenant.userId,
      transaction
    );

    const summary = await nayObrasService.summarizeProject(project.id, transaction);

    assert.ok(Array.isArray(summary.visualAnalysisSuggestions));
    assert.ok(summary.visualAnalysisSuggestions.length > 0);
    const suggestion = summary.visualAnalysisSuggestions.find((s) => s.type === 'NO_DAILY_REPORT_PHOTO');
    assert.ok(suggestion, 'esperava uma sugestão do tipo NO_DAILY_REPORT_PHOTO');
    assert.match(suggestion.message, /evidência visual/);
    assert.match(suggestion.message, /confirmação humana/);
  });
});

test('GAP 3 — risco de medição pendente de aprovação há muito tempo aparece em risks, e decisionsMade permanece []', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const project = await createTestProject(transaction, suffix);
    const stage = await projectStagesService.createProjectStage(
      project.id,
      withTenant({ name: `Etapa NAY QA ${suffix}`, sequence: 1 }),
      tenant.userId,
      transaction
    );

    const staleSubmittedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000); // 20 dias atrás
    await StageMeasurement.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        projectStageId: stage.id,
        measuredPct: 10,
        measuredAt: '2026-09-01',
        status: 'SUBMITTED',
        submittedAt: staleSubmittedAt,
        createdAt: staleSubmittedAt,
      },
      { transaction }
    );

    const summary = await nayObrasService.summarizeProject(project.id, transaction);

    const risk = summary.risks.find((r) => /aguardando aprovação\/rejeição humana/.test(r));
    assert.ok(risk, `esperava risco de medição pendente de aprovação em risks: ${JSON.stringify(summary.risks)}`);
    assert.match(risk, /nenhuma aprovação é feita automaticamente/);

    // M6-27 — a trava "NAY sugere, nunca decide" não é violada: decisionsMade continua vazio
    // mesmo com o risco de medição pendente sinalizado.
    assert.deepEqual(summary.decisionsMade, []);
  });
});

test('GAP 3 — risco de medição PAYABLE sem pagamento processado há muito tempo aparece em risks', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const project = await createTestProject(transaction, suffix);
    const stage = await projectStagesService.createProjectStage(
      project.id,
      withTenant({ name: `Etapa NAY QA PAYABLE ${suffix}`, sequence: 1 }),
      tenant.userId,
      transaction
    );

    const staleApprovedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    await StageMeasurement.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        projectStageId: stage.id,
        measuredPct: 10,
        measuredAt: '2026-09-01',
        status: 'PAYABLE',
        approvedAt: staleApprovedAt,
        payableFinancialEntryId: null,
        createdAt: staleApprovedAt,
      },
      { transaction }
    );

    const summary = await nayObrasService.summarizeProject(project.id, transaction);

    const risk = summary.risks.find((r) => /sem lançamento de pagamento processado/.test(r));
    assert.ok(risk, `esperava risco de medição PAYABLE sem pagamento em risks: ${JSON.stringify(summary.risks)}`);
    assert.match(risk, /nenhum pagamento é processado automaticamente/);
    assert.deepEqual(summary.decisionsMade, []);
  });
});
