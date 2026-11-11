'use strict';

// Verificação independente do Marco 6 — M6-17, M6-82 e M6-42. Guia §3 "Nunca UPDATE no baseline aprovado"; Caderno §2
// "mudança somente por Change Order aprovado". O Change Order aprovado vira revisão append-only; a baseline aprovada
// (orçamento e obra) fica intacta; o painel mostra baseline e aditivos separados, sem contar o aditivo duas vezes; o
// banco recusa UPDATE na baseline aprovada e UPDATE/DELETE nas revisões.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./testHelpers');
const { W, projectWithApprovedBudget, evidenceIds } = require('./constructionM6vFixture');
const { Budget, Project, BudgetRevision, sequelize } = require('../src/models');
const changeOrdersService = require('../src/features/construction/changeOrders.service');
const projectHealthService = require('../src/features/construction/projectHealth.service');
const dashboardService = require('../src/features/construction/dashboard.service');

let tenant;
before(async () => {
  tenant = await H.getSeedTenant();
});
after(async () => {
  await H.sequelize.close();
});

async function aprovarAditivo(t, project, impacto) {
  const co = await changeOrdersService.createChangeOrder(
    project.id,
    W(tenant, { reasonCode: 'ESCOPO', description: `Aditivo ${impacto}`, budgetImpact: impacto, scheduleImpactDays: 3, evidenceFileIds: await evidenceIds(tenant, t), idempotencyKey: `m6v-co-${H.uniqueSuffix()}` }),
    tenant.userId,
    t
  );
  return changeOrdersService.decideChangeOrder(co.id, { decision: 'APPROVE' }, tenant.userId, t);
}

test('M6-17/M6-82: Change Order aprovado cria revisão nova e NÃO altera a baseline aprovada (orçamento nem obra)', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const { project, budget } = await projectWithApprovedBudget(tenant, t, { baseline: 80000 });
    assert.equal(Number(budget.baselineAmount), 80000);
    const co1 = await aprovarAditivo(t, project, 6000);
    const co2 = await aprovarAditivo(t, project, -1500);

    const depois = await Budget.findByPk(budget.id, { transaction: t });
    assert.equal(Number(depois.baselineAmount), 80000, 'baseline aprovada intacta');
    assert.equal(Number(depois.totalAmount), 80000);
    assert.equal(Number((await Project.findByPk(project.id, { transaction: t })).budgetAmount), 80000, 'orçamento da obra = baseline aprovada');

    const revisoes = await changeOrdersService.listBudgetRevisions(project.id, t);
    assert.deepEqual(
      revisoes.map((r) => [r.revisionNumber, r.changeOrderId, Number(r.previousTotal), Number(r.budgetImpact), Number(r.newTotal)]),
      [[1, co1.id, 80000, 6000, 86000], [2, co2.id, 86000, -1500, 84500]]
    );
  });
});

test('M6-42: painel mostra baselineBudget = baseline original e approvedChanges = aditivos, sem contar duas vezes', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const { project } = await projectWithApprovedBudget(tenant, t, { baseline: 80000 });
    await aprovarAditivo(t, project, 6000);
    const health = await projectHealthService.getProjectHealth(project.id, t);
    assert.equal(health.baselineBudget, 80000);
    assert.equal(health.approvedChanges, 6000);
    assert.equal(health.currentApprovedBudget, 86000);
    assert.equal(health.committedCost, 80000);

    const antes = (await dashboardService.getConstructionDashboard(W(tenant), t)).obras;
    await aprovarAditivo(t, project, 2500);
    const depois = (await dashboardService.getConstructionDashboard(W(tenant), t)).obras;
    assert.equal(Math.round((depois.baselineBudgetTotal - antes.baselineBudgetTotal) * 100) / 100, 0, 'aditivo não entra na baseline do painel');
    assert.equal(Math.round((depois.approvedChangesTotal - antes.approvedChangesTotal) * 100) / 100, 2500, 'aditivo entra uma vez em approvedChanges');
    const health2 = await projectHealthService.getProjectHealth(project.id, t);
    assert.equal(health2.baselineBudget, 80000);
    assert.equal(health2.approvedChanges, 8500);
  });
});

test('M6-17: o banco recusa UPDATE na baseline aprovada e UPDATE/DELETE nas revisões (append-only)', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const { project, budget } = await projectWithApprovedBudget(tenant, t, { baseline: 50000 });
    await aprovarAditivo(t, project, 1000);
    const tentar = async (sql, replacements) => {
      try {
        await sequelize.transaction({ transaction: t }, (sp) => sequelize.query(sql, { replacements, transaction: sp }));
        return null;
      } catch (err) {
        return err;
      }
    };
    const e1 = await tentar('UPDATE construction.budgets SET baseline_amount = 99999 WHERE id = :id', { id: budget.id });
    assert.match(String(e1 && e1.message), /baseline aprovada é imutável/);
    const e2 = await tentar('UPDATE construction.budgets SET total_amount = 1 WHERE id = :id', { id: budget.id });
    assert.match(String(e2 && e2.message), /baseline aprovada é imutável/);
    const rev = await BudgetRevision.findOne({ where: { projectId: project.id }, transaction: t });
    const e3 = await tentar('UPDATE construction.budget_revisions SET new_total = 1 WHERE id = :id', { id: rev.id });
    assert.match(String(e3 && e3.message), /append-only/);
    const e4 = await tentar('DELETE FROM construction.budget_revisions WHERE id = :id', { id: rev.id });
    assert.ok(e4, 'DELETE recusado (sem permissão no runtime ou pelo gatilho)');
    assert.equal(Number((await Budget.findByPk(budget.id, { transaction: t })).baselineAmount), 50000);
  });
});

test('M6-17: Change Order que deixaria o orçamento negativo é recusado sem gravar revisão', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const { project } = await projectWithApprovedBudget(tenant, t, { baseline: 1000 });
    await assert.rejects(aprovarAditivo(t, project, -5000), { code: 'CHANGE_ORDER_NEGATIVE_RESULT' });
  });
});
