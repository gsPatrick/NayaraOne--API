'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const budgetsService = require('../src/features/construction/budgets.service');
const budgetLinesService = require('../src/features/construction/budgetLines.service');
const changeOrdersService = require('../src/features/construction/changeOrders.service');
const marginRulesService = require('../src/features/construction/marginRules.service');
const AppError = require('../src/utils/AppError');

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

async function createProjectWithApprovedBudget(transaction, { plannedAmount = 1000, minMarginPct = 10 } = {}) {
  const project = await projectsService.createProject(
    withTenant({ name: `HOMO QA Obra ${Date.now()}${Math.floor(Math.random() * 10000)}` }),
    tenant.userId,
    transaction
  );
  await marginRulesService.createMarginRule(withTenant({ minMarginPct }), tenant.userId, transaction);
  const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
  const line = await budgetLinesService.createBudgetLine(
    project.id,
    withTenant({ category: 'FUNDACAO', plannedAmount, budgetId: budget.id }),
    tenant.userId,
    transaction
  );
  const approved = await budgetsService.approveBudget(budget.id, tenant.userId, transaction);
  return { project, budget: approved, line };
}

// M6-54 / M6-17 / M6-82: baseline aprovada é imutável — UPDATE direto de valor tem que bloquear.

test('M6-54: editar plannedAmount de linha de orçamento com baseline APPROVED é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { line } = await createProjectWithApprovedBudget(transaction, { plannedAmount: 5000 });

    await assert.rejects(
      () => budgetLinesService.updateBudgetLine(line.id, { plannedAmount: 9999 }, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'BUDGET_LINE_BASELINE_LOCKED');
        return true;
      }
    );

    // M6-22 (corrigido em 30/09/2026): actualAmount nunca é editável via este endpoint,
    // aprovado ou não — custo realizado só vem de integração com Financeiro/Estoque.
    await assert.rejects(
      () => budgetLinesService.updateBudgetLine(line.id, { actualAmount: 100 }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'BUDGET_LINE_ACTUAL_AMOUNT_READONLY');
        return true;
      }
    );
  });
});

test('M6-22: actualAmount não pode ser editado nem em orçamento ainda DRAFT (nunca via UPDATE direto)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: 'Obra M6-22', managerUserId: tenant.userId },
      tenant.userId,
      transaction
    );
    const line = await budgetLinesService.createBudgetLine(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, category: 'Material', plannedAmount: 1000 },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => budgetLinesService.updateBudgetLine(line.id, { actualAmount: 500 }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'BUDGET_LINE_ACTUAL_AMOUNT_READONLY');
        return true;
      }
    );
  });
});

test('M6-54: campos não financeiros de uma linha com baseline APPROVED continuam editáveis', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { line } = await createProjectWithApprovedBudget(transaction);
    const updated = await budgetLinesService.updateBudgetLine(line.id, { description: 'ajuste de texto' }, tenant.userId, transaction);
    assert.equal(updated.description, 'ajuste de texto');
  });
});

test('M6-54/M6-17: não é possível criar linha nova em orçamento já APPROVED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project, budget } = await createProjectWithApprovedBudget(transaction);

    await assert.rejects(
      () =>
        budgetLinesService.createBudgetLine(
          project.id,
          withTenant({ category: 'EXTRA', plannedAmount: 500, budgetId: budget.id }),
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'BUDGET_LINE_BASELINE_LOCKED');
        return true;
      }
    );
  });
});

test('M6-17/M6-32: aprovar orçamento fora de DRAFT (já APPROVED) é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { budget } = await createProjectWithApprovedBudget(transaction);
    await assert.rejects(
      () => budgetsService.approveBudget(budget.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'BUDGET_NOT_DRAFT');
        return true;
      }
    );
  });
});

// M6-06/M6-33/M6-82: Change Order aprovado é a ÚNICA forma de alterar valor de orçamento já
// aprovado — este teste comprova que o caminho de exceção realmente funciona (não é só bloqueio).

test('M6-33/M6-82: Change Order aprovado altera o baseline do orçamento já congelado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project, budget } = await createProjectWithApprovedBudget(transaction, { plannedAmount: 1000 });
    assert.equal(Number(budget.baselineAmount), 1000);

    const changeOrder = await changeOrdersService.createChangeOrder(
      project.id,
      withTenant({ reasonCode: 'ESCOPO_ADICIONAL', description: 'Reforço estrutural não previsto', budgetImpact: 250 }),
      tenant.userId,
      transaction
    );
    assert.equal(changeOrder.status, 'PENDING_APPROVAL');

    const decided = await changeOrdersService.decideChangeOrder(changeOrder.id, { decision: 'APPROVE' }, tenant.userId, transaction);
    assert.equal(decided.status, 'APPROVED');

    const budgetsService2 = require('../src/features/construction/budgets.service');
    const reloaded = await budgetsService2.getBudget(budget.id, transaction);
    assert.equal(Number(reloaded.baselineAmount), 1250);
  });
});

test('Change Order não pode ser aprovado se a obra não tem orçamento APPROVED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra sem orçamento ${Date.now()}` }),
      tenant.userId,
      transaction
    );
    const changeOrder = await changeOrdersService.createChangeOrder(
      project.id,
      withTenant({ reasonCode: 'X', description: 'desc', budgetImpact: 10 }),
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => changeOrdersService.decideChangeOrder(changeOrder.id, { decision: 'APPROVE' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'CHANGE_ORDER_NO_APPROVED_BUDGET');
        return true;
      }
    );
  });
});

test('Change Order rejeitado não altera o orçamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project, budget } = await createProjectWithApprovedBudget(transaction, { plannedAmount: 1000 });
    const changeOrder = await changeOrdersService.createChangeOrder(
      project.id,
      withTenant({ reasonCode: 'X', description: 'desc', budgetImpact: 999 }),
      tenant.userId,
      transaction
    );
    const decided = await changeOrdersService.decideChangeOrder(changeOrder.id, { decision: 'REJECT' }, tenant.userId, transaction);
    assert.equal(decided.status, 'REJECTED');

    const reloaded = await budgetsService.getBudget(budget.id, transaction);
    assert.equal(Number(reloaded.baselineAmount), 1000);
  });
});

// M6-61: regra de margem alterada depois de aprovado o orçamento — a versão vigente NA HORA DA
// APROVAÇÃO precisa ficar preservada mesmo que uma versão nova seja criada depois.

test('M6-61: rule_version_id gravado no orçamento é preservado mesmo após nova versão da regra ser criada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const firstRule = await marginRulesService.createMarginRule(withTenant({ minMarginPct: 12 }), tenant.userId, transaction);

    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra margem ${Date.now()}${Math.floor(Math.random() * 10000)}` }),
      tenant.userId,
      transaction
    );
    const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
    await budgetLinesService.createBudgetLine(project.id, withTenant({ category: 'X', plannedAmount: 100, budgetId: budget.id }), tenant.userId, transaction);
    const approved = await budgetsService.approveBudget(budget.id, tenant.userId, transaction);

    assert.equal(approved.ruleVersionId, firstRule.id);

    // Regra muda DEPOIS que o orçamento já foi aprovado.
    const secondRule = await marginRulesService.createMarginRule(withTenant({ minMarginPct: 20 }), tenant.userId, transaction);
    assert.notEqual(secondRule.id, firstRule.id);

    const reloadedBudget = await budgetsService.getBudget(budget.id, transaction);
    assert.equal(reloadedBudget.ruleVersionId, firstRule.id, 'orçamento já aprovado deve continuar apontando para a versão vigente na aprovação');
    assert.notEqual(reloadedBudget.ruleVersionId, secondRule.id);

    const activeRuleNow = await marginRulesService.getActiveMarginRule(tenant.groupId, tenant.companyId, transaction);
    assert.equal(activeRuleNow.id, secondRule.id);

    // Novo orçamento criado agora usa a versão nova.
    const project2 = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra margem 2 ${Date.now()}${Math.floor(Math.random() * 10000)}` }),
      tenant.userId,
      transaction
    );
    const budget2 = await budgetsService.createBudget(project2.id, withTenant({}), tenant.userId, transaction);
    await budgetLinesService.createBudgetLine(project2.id, withTenant({ category: 'X', plannedAmount: 100, budgetId: budget2.id }), tenant.userId, transaction);
    const approved2 = await budgetsService.approveBudget(budget2.id, tenant.userId, transaction);
    assert.equal(approved2.ruleVersionId, secondRule.id);
  });
});

test('Aprovar orçamento sem nenhuma margem mínima configurada é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra sem regra ${Date.now()}` }),
      tenant.userId,
      transaction
    );
    const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
    await assert.rejects(
      () => budgetsService.approveBudget(budget.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'MARGIN_RULE_NOT_CONFIGURED');
        return true;
      }
    );
  });
});

test('Uma obra não pode ter dois orçamentos agregados', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra dupla ${Date.now()}` }),
      tenant.userId,
      transaction
    );
    await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
    await assert.rejects(
      () => budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'BUDGET_ALREADY_EXISTS');
        return true;
      }
    );
  });
});

// M6-67/M6-93: updates concorrentes no mesmo orçamento não podem ambos aprovar (lock pessimista).

test('M6-67: duas aprovações concorrentes do mesmo orçamento — só uma vence, a outra recebe conflito', async () => {
  // Concorrência real precisa de transações COMMITADAS (duas conexões enxergando o mesmo
  // estado) — mesmo padrão de test/adversarial.finance.test.js (ADV-F21). Escreve de verdade
  // no banco compartilhado e limpa os dados no final (hard delete, nunca fica sujeira).
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

  const { MarginRule: MarginRuleModel } = require('../src/models');
  const previouslyActiveRule = await MarginRuleModel.findOne({ where: { groupId: tenant.groupId, companyId: tenant.companyId, isActive: true } });

  const { projectId, budgetId, marginRuleId } = await withCommitted(async (t) => {
    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra concorrencia ${Date.now()}${Math.floor(Math.random() * 10000)}` }),
      tenant.userId,
      t
    );
    const marginRule = await marginRulesService.createMarginRule(withTenant({ minMarginPct: 10 }), tenant.userId, t);
    const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, t);
    await budgetLinesService.createBudgetLine(project.id, withTenant({ category: 'X', plannedAmount: 100, budgetId: budget.id }), tenant.userId, t);
    return { projectId: project.id, budgetId: budget.id, marginRuleId: marginRule.id };
  });

  try {
    const results = await Promise.allSettled([
      withCommitted((t) => budgetsService.approveBudget(budgetId, tenant.userId, t)),
      withCommitted((t) => budgetsService.approveBudget(budgetId, tenant.userId, t)),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exatamente uma aprovação deve ter sucesso');
    assert.equal(rejected.length, 1, 'a segunda aprovação concorrente deve ser rejeitada');
    assert.equal(rejected[0].reason.code, 'BUDGET_NOT_DRAFT');

    await withCommitted(async (t) => {
      const budget = await budgetsService.getBudget(budgetId, t);
      assert.equal(budget.status, 'APPROVED');
      assert.equal(Number(budget.baselineAmount), 100, 'baseline não pode ter sido congelada duas vezes/duplicada');
    });
  } finally {
    // Limpeza: dados de teste commitados de verdade em banco compartilhado, removidos via
    // hard delete direto (mesmo padrão de ADV-F21) pra não poluir outros agentes/suítes. A
    // margem mínima que estava ativa ANTES deste teste é reativada, restaurando o estado do
    // tenant compartilhado.
    const { Budget, BudgetLine, Project } = require('../src/models');
    await withCommitted(async (t) => {
      await BudgetLine.destroy({ where: { projectId }, transaction: t, force: true });
      await Budget.destroy({ where: { id: budgetId }, transaction: t, force: true });
      await Project.destroy({ where: { id: projectId }, transaction: t, force: true });
      await MarginRuleModel.destroy({ where: { id: marginRuleId }, transaction: t, force: true });
      if (previouslyActiveRule) {
        await MarginRuleModel.update({ isActive: true }, { where: { id: previouslyActiveRule.id }, transaction: t });
      }
    });
  }
});

// M6-57/M6-66: RLS — não é possível acessar orçamento de outra empresa.

test('M6-57/M6-66: orçamento não é visível fora do contexto de tenant correto (RLS)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra RLS ${Date.now()}` }),
      tenant.userId,
      transaction
    );
    const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);

    // Muda o contexto de tenant DENTRO da mesma transação para um company_id inexistente —
    // RLS deve impedir a leitura da linha mesmo sabendo o ID exato.
    await sequelize.query("SET LOCAL app.company_id = '00000000-0000-0000-0000-000000000000'", { transaction });

    await assert.rejects(
      () => budgetsService.getBudget(budget.id, transaction),
      (err) => {
        assert.equal(err.code, 'BUDGET_NOT_FOUND');
        return true;
      }
    );
  });
});
