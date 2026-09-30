'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const budgetsService = require('../src/features/construction/budgets.service');
const marginRulesService = require('../src/features/construction/marginRules.service');
const dailyReportsService = require('../src/features/construction/dailyReports.service');
const { detectMissingDailyReports, previousBusinessDay } = require('../src/engines/jobs/missingDailyReportJob');
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
  const project = await projectsService.createProject(withTenant({ name: `Obra RDO ausente ${uniqueSuffix()}` }), tenant.userId, transaction);
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
