'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const budgetsService = require('../src/features/construction/budgets.service');
const marginRulesService = require('../src/features/construction/marginRules.service');
const dailyReportsService = require('../src/features/construction/dailyReports.service');
const peopleService = require('../src/features/people/people.service');
const { detectMissingDailyReports, detectMissingWorkerDocuments, previousBusinessDay } = require('../src/engines/jobs/missingDailyReportJob');
const { Task } = require('../src/models');

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

// Mesmo helper usado em construction.delivery.test.js: percorre a máquina de estados real até
// ACTIVE (a única condição pra entrar no escopo do job — ver "9. Qualidade, entrega e pós-obra").
async function createActiveProject(transaction) {
  const project = await projectsService.createProject(
    withTenant({
      name: `Obra RDO ausente ${uniqueSuffix()}`,
      responsibleUserId: tenant.userId,
      startsAt: '2026-10-01',
      endsAtPlanned: '2027-10-01',
    }),
    tenant.userId,
    transaction
  );
  await marginRulesService.createMarginRule(withTenant({ minMarginPct: 10 }), tenant.userId, transaction);
  const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
  await budgetsService.approveBudget(budget.id, tenant.userId, transaction); // PLANNED -> BUDGETED
  await projectsService.transitionProject(project.id, 'READY', tenant.userId, transaction);
  await projectsService.transitionProject(project.id, 'ACTIVE', tenant.userId, transaction);
  return projectsService.getProject(project.id, transaction);
}

function toDateOnlyString(date) {
  return date.toISOString().slice(0, 10);
}

// Achado numa rodada de verificação de integrações (30/09/2026): a fonte exige — "Fotos possuem
// hash/origem; ausência de diário gera tarefa conforme regra." (seção "6. Diário") — nenhum job
// existia para detectar a ausência de RDO.

test('missingDailyReportJob: obra ACTIVE sem RDO no dia útil anterior gera tarefa em core.tasks', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createActiveProject(transaction);

    const result = await detectMissingDailyReports(transaction, new Date());
    assert.ok(result.tasksCreated >= 1);

    const tasks = await Task.findAll({
      where: { relatedEntityType: 'construction.projects', relatedEntityId: project.id },
      transaction,
    });
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].title, /RDO ausente/);
    assert.equal(tasks[0].status, 'OPEN');
  });
});

// BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 19, Frente A, 09/10/2026): cada projeto era
// verificado/criava sua Task direto na transação da empresa, sem savepoint — um projeto com
// problema (ex.: Task.create falhando por FK órfã em assignedToUserId) abortava a verificação
// de TODOS os outros projetos do mesmo lote. Confirma que, com um projeto "quebrado" no meio da
// lista, os demais ainda recebem sua tarefa normalmente.
test('missingDailyReportJob: um projeto com falha no Task.create não impede a tarefa dos demais projetos (savepoint por projeto)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const brokenProject = await createActiveProject(transaction);
    const healthyProject = await createActiveProject(transaction);

    // Simula uma falha real (ex.: FK órfã, violação de constraint) isolada a UM projeto
    // específico, sem depender de burlar a FK de responsibleUserId (que é validada tanto na
    // criação do Project quanto na do Task — não dá pra montar o cenário só com dados).
    const originalCreate = Task.create.bind(Task);
    Task.create = async (values, options) => {
      if (values.relatedEntityId === brokenProject.id) {
        throw new Error('Falha simulada no Task.create para este projeto específico.');
      }
      return originalCreate(values, options);
    };

    let result;
    try {
      result = await detectMissingDailyReports(transaction, new Date());
    } finally {
      Task.create = originalCreate;
    }
    assert.ok(result.tasksCreated >= 1, 'o projeto saudável precisa ter recebido sua tarefa mesmo com o outro projeto falhando');

    const healthyTasks = await Task.findAll({
      where: { relatedEntityType: 'construction.projects', relatedEntityId: healthyProject.id },
      transaction,
    });
    assert.equal(healthyTasks.length, 1, 'o projeto saudável precisa ter exatamente 1 tarefa, não bloqueada pela falha do outro projeto');

    const brokenTasks = await Task.findAll({
      where: { relatedEntityType: 'construction.projects', relatedEntityId: brokenProject.id },
      transaction,
    });
    assert.equal(brokenTasks.length, 0, 'o projeto com FK inválida não deve ter conseguido criar a tarefa (erro isolado, não propagado)');
  });
});

test('missingDailyReportJob: obra com RDO registrado no dia útil anterior não gera tarefa', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createActiveProject(transaction);
    const checkDate = toDateOnlyString(previousBusinessDay(new Date()));

    await dailyReportsService.createDailyReport(project.id, withTenant({ reportDate: checkDate }), tenant.userId, transaction);

    const result = await detectMissingDailyReports(transaction, new Date());
    assert.equal(result.tasksCreated, 0);

    const tasks = await Task.findAll({
      where: { relatedEntityType: 'construction.projects', relatedEntityId: project.id },
      transaction,
    });
    assert.equal(tasks.length, 0);
  });
});

test('missingDailyReportJob: idempotente — rodar duas vezes no mesmo dia não duplica a tarefa', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createActiveProject(transaction);
    const now = new Date();

    await detectMissingDailyReports(transaction, now);
    const secondRun = await detectMissingDailyReports(transaction, now);
    assert.equal(secondRun.tasksCreated, 0, 'segunda execução no mesmo dia não deveria criar tarefa duplicada');

    const tasks = await Task.findAll({
      where: { relatedEntityType: 'construction.projects', relatedEntityId: project.id },
      transaction,
    });
    assert.equal(tasks.length, 1);
  });
});

// GAP REAL CORRIGIDO (auditoria externa Nayara, 2026-10-08): missingDailyReportJob só cobria
// ausência de DIÁRIO — a fonte também exige detectar ausência de DOCUMENTOS do trabalhador
// (DailyWorker.documentFileIds). Confirma que um trabalhador sem documentFileIds num RDO da
// obra gera uma Task distinta (relatedEntityType = 'construction.daily_workers').
test('missingDailyReportJob: trabalhador sem documentFileIds em RDO recente gera tarefa de documentação pendente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createActiveProject(transaction);
    const checkDate = toDateOnlyString(previousBusinessDay(new Date()));
    const worker = await peopleService.createPerson(
      withTenant({ personType: 'PF', legalName: `Pedreiro sem doc ${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );

    await dailyReportsService.createDailyReport(
      project.id,
      withTenant({
        reportDate: checkDate,
        workers: [{ personId: worker.id, role: 'Pedreiro' }], // sem documentFileIds
      }),
      tenant.userId,
      transaction
    );

    const result = await detectMissingWorkerDocuments(transaction, new Date());
    assert.ok(result.tasksCreated >= 1);

    const tasks = await Task.findAll({
      where: { relatedEntityType: 'construction.daily_workers', relatedEntityId: project.id },
      transaction,
    });
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].title, /Documentação/);
    assert.equal(tasks[0].status, 'OPEN');
  });
});

// Trabalhador COM documentFileIds preenchido não deve gerar tarefa nenhuma.
test('missingDailyReportJob: trabalhador com documentFileIds preenchido não gera tarefa de documentação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createActiveProject(transaction);
    const checkDate = toDateOnlyString(previousBusinessDay(new Date()));
    const worker = await peopleService.createPerson(
      withTenant({ personType: 'PF', legalName: `Pedreiro com doc ${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );

    await dailyReportsService.createDailyReport(
      project.id,
      withTenant({
        reportDate: checkDate,
        workers: [{ personId: worker.id, role: 'Pedreiro', documentFileIds: ['11111111-1111-1111-1111-111111111111'] }],
      }),
      tenant.userId,
      transaction
    );

    const result = await detectMissingWorkerDocuments(transaction, new Date());
    assert.equal(result.tasksCreated, 0);

    const tasks = await Task.findAll({
      where: { relatedEntityType: 'construction.daily_workers', relatedEntityId: project.id },
      transaction,
    });
    assert.equal(tasks.length, 0);
  });
});

// Idempotência: rodar a verificação de documentação duas vezes na mesma janela não duplica a tarefa.
test('missingDailyReportJob: verificação de documentação é idempotente — rodar 2x não duplica a tarefa', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createActiveProject(transaction);
    const checkDate = toDateOnlyString(previousBusinessDay(new Date()));
    const worker = await peopleService.createPerson(
      withTenant({ personType: 'PF', legalName: `Pedreiro idempotente ${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );

    await dailyReportsService.createDailyReport(
      project.id,
      withTenant({ reportDate: checkDate, workers: [{ personId: worker.id, role: 'Pedreiro' }] }),
      tenant.userId,
      transaction
    );

    const now = new Date();
    await detectMissingWorkerDocuments(transaction, now);
    const secondRun = await detectMissingWorkerDocuments(transaction, now);
    assert.equal(secondRun.tasksCreated, 0, 'segunda execução não deveria criar tarefa duplicada');

    const tasks = await Task.findAll({
      where: { relatedEntityType: 'construction.daily_workers', relatedEntityId: project.id },
      transaction,
    });
    assert.equal(tasks.length, 1);
  });
});
