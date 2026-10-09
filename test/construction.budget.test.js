'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { Company } = require('../src/models');
const projectsService = require('../src/features/construction/projects.service');
const budgetsService = require('../src/features/construction/budgets.service');
const budgetLinesService = require('../src/features/construction/budgetLines.service');
const changeOrdersService = require('../src/features/construction/changeOrders.service');
const marginRulesService = require('../src/features/construction/marginRules.service');
const lossRecordsService = require('../src/features/construction/lossRecords.service');
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

// BUG REAL CORRIGIDO (auditoria E2E ao vivo, Marco 6, Ciclo 8, 2026-10-06): não existia nenhum
// jeito de remover uma linha de orçamento digitada errada antes da aprovação.
test('removeBudgetLine remove linha em DRAFT, mas recusa remover linha de orçamento já APPROVED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(withTenant({ name: `Obra remove-line ${Date.now()}` }), tenant.userId, transaction);
    const line = await budgetLinesService.createBudgetLine(project.id, withTenant({ category: 'EXTRA', plannedAmount: 200 }), tenant.userId, transaction);
    await budgetLinesService.removeBudgetLine(line.id, tenant.userId, transaction);
    await assert.rejects(
      () => budgetLinesService.getBudgetLine(line.id, transaction),
      (err) => { assert.equal(err.code, 'BUDGET_LINE_NOT_FOUND'); return true; }
    );

    const { line: approvedLine } = await createProjectWithApprovedBudget(transaction, { plannedAmount: 500 });
    await assert.rejects(
      () => budgetLinesService.removeBudgetLine(approvedLine.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'BUDGET_LINE_BASELINE_LOCKED'); return true; }
    );
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
      withTenant({ reasonCode: 'ESCOPO_ADICIONAL', description: 'Reforço estrutural não previsto', budgetImpact: 250, scheduleImpactDays: 0, evidenceFileIds: ['99999999-9999-9999-9999-999999999999'], idempotencyKey: `co-${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );
    assert.equal(changeOrder.status, 'PENDING_APPROVAL');

    const decided = await changeOrdersService.decideChangeOrder(changeOrder.id, { decision: 'APPROVE' }, tenant.userId, transaction);
    assert.equal(decided.status, 'APPROVED');

    const budgetsService2 = require('../src/features/construction/budgets.service');
    const reloaded = await budgetsService2.getBudget(budget.id, transaction);
    assert.equal(Number(reloaded.baselineAmount), 1250);

    // Bug real corrigido nesta auditoria (rodada 48, 2026-10-05): approveBudget (R46) já
    // sincroniza project.budgetAmount, mas decideChangeOrder (única outra forma de mudar um
    // baseline já aprovado) não replicava isso — project.budgetAmount ficava desatualizado
    // depois do primeiro Change Order aprovado.
    const reloadedProject = await projectsService.getProject(project.id, transaction);
    assert.equal(Number(reloadedProject.budgetAmount), 1250, 'project.budgetAmount precisa acompanhar o novo baseline aprovado pelo Change Order');
  });
});

// BUG REAL CORRIGIDO (auditoria E2E ao vivo, Marco 6, Ciclo 4, 2026-10-06): projectHealth.
// service.js somava baselineBudget + approvedChanges pra calcular projectedMargin, mas
// baselineBudget (vindo de project.budgetAmount) JÁ é sincronizado com o Change Order aprovado
// em decideChangeOrder — somar approvedChanges de novo inflava a margem projetada artificialmente
// (podia mascarar um alerta de margem abaixo da regra configurada).
test('M6-42: projectedMargin não conta o Change Order aprovado duas vezes (baseline já sincronizada)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project, budget } = await createProjectWithApprovedBudget(transaction, { plannedAmount: 1000 });
    const changeOrder = await changeOrdersService.createChangeOrder(
      project.id,
      withTenant({ reasonCode: 'ESCOPO_ADICIONAL', description: 'Reforço estrutural não previsto', budgetImpact: 250, scheduleImpactDays: 0, evidenceFileIds: ['99999999-9999-9999-9999-999999999999'], idempotencyKey: `co-${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );
    await changeOrdersService.decideChangeOrder(changeOrder.id, { decision: 'APPROVE' }, tenant.userId, transaction);

    const projectHealthService = require('../src/features/construction/projectHealth.service');
    const health = await projectHealthService.getProjectHealth(project.id, transaction);

    assert.equal(health.committedCost, 1000);
    assert.equal(health.approvedChanges, 250);
    // Sem custo real lançado ainda: forecastToComplete = committedCost + approvedChanges = 1250,
    // projectedTotalCost = 1250. Margem projetada correta é 0 (1250 - 1250), nunca 250
    // (que seria o resultado se approvedChanges fosse somado duas vezes).
    assert.equal(health.projectedTotalCost, 1250);
    assert.equal(health.projectedMargin, 0, 'approvedChanges não pode ser somado duas vezes na margem');
  });
});

// GAP CORRIGIDO (auditoria pós-Marco 6, item 3): consumedInventoryCost ficava hard-coded em 0
// porque não havia vínculo projectId em inventory.inventory_movements. Confirma que, com um
// movimento OUT real vinculado ao projectId da obra, o read model soma custo real
// (quantidade * custo médio do item) — e que RETURN abate esse custo.
test('M6-42: consumedInventoryCost soma o custo real de saídas de estoque vinculadas à obra (OUT - RETURN)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { InventoryItem, InventoryLocation } = require('../src/models');
    const inventoryMovementsService = require('../src/features/inventory/movements.service');

    const { project } = await createProjectWithApprovedBudget(transaction, { plannedAmount: 1000 });

    const location = await InventoryLocation.create(
      withTenant({ name: `HOMO QA Deposito ${Date.now()}`, locationType: 'WAREHOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }),
      { transaction }
    );
    const item = await InventoryItem.create(
      withTenant({
        name: `HOMO QA Cimento ${Date.now()}`,
        unitOfMeasure: 'saco',
        itemType: 'CONSUMABLE',
        averageCost: 30,
        allowNegativeStock: true,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      }),
      { transaction }
    );
    await inventoryMovementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 100, destinationLocationId: location.id }),
      { userId: tenant.userId, canApprove: true },
      transaction
    );

    const projectHealthService = require('../src/features/construction/projectHealth.service');
    const healthBefore = await projectHealthService.getProjectHealth(project.id, transaction);
    assert.equal(healthBefore.consumedInventoryCost, 0, 'sem movimento vinculado ao projectId, custo de estoque consumido é 0');
    // Sem consumo e sem custo financeiro lançado: forecastToComplete = committedCost (1000),
    // projectedTotalCost = 1000, projectedMargin = committedCost - projectedTotalCost = 0.
    assert.equal(healthBefore.forecastToComplete, 1000);
    assert.equal(healthBefore.projectedTotalCost, 1000);
    assert.equal(healthBefore.projectedMargin, 0);

    // Saída de 20 sacos a R$30 = R$600 consumidos pela obra.
    await inventoryMovementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, projectId: project.id, movementType: 'OUT', quantity: 20, sourceLocationId: location.id, sourceType: 'MANUAL' }),
      { userId: tenant.userId, canApprove: true },
      transaction
    );
    const healthAfterOut = await projectHealthService.getProjectHealth(project.id, transaction);
    assert.equal(healthAfterOut.consumedInventoryCost, 600, 'custo real de estoque consumido deveria ser quantidade * custo médio do item');

    // GAP CORRIGIDO (auditoria pós-Marco 6, item 1): consumedInventoryCost agora É considerado
    // custo real da obra em forecastToComplete/projectedTotalCost/projectedMargin, mesmo sem
    // NENHUM FinancialEntry lançado ainda — "Custo realizado vem de Financeiro/Estoque"
    // (contrato, seção 5). committedCost=1000, consumedInventoryCost=600, actualFinancialCost=0:
    // forecastToComplete = max(1000 + 0 - (0 + 600), 0) = 400; projectedTotalCost = 600 + 400 =
    // 1000; projectedMargin = 1000 (committedCost) - 1000 (projectedTotalCost) = 0... mas o
    // ponto crucial é que a margem JÁ REFLETE o consumo: se a obra consumir MAIS do que o
    // orçado (ver abaixo), a margem cai mesmo sem Financeiro.
    assert.equal(healthAfterOut.forecastToComplete, 400, 'forecastToComplete precisa abater o estoque já consumido do que falta');
    assert.equal(healthAfterOut.projectedTotalCost, 1000, 'projectedTotalCost precisa refletir o estoque consumido como parte do custo real');
    assert.equal(healthAfterOut.projectedMargin, 0, 'margem projetada sem Financeiro ainda reflete o consumo de estoque');

    // Consumo extra (mais 25 sacos, R$750) ultrapassa o committedCost total só com estoque —
    // SEM nenhum lançamento financeiro. Isso precisa fazer a margem CAIR (ficar negativa) e o
    // custo total projetado SUBIR acima do orçado — prova de que consumedInventoryCost está de
    // fato integrado, não só exposto no JSON sem efeito.
    await inventoryMovementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, projectId: project.id, movementType: 'OUT', quantity: 25, sourceLocationId: location.id, sourceType: 'MANUAL' }),
      { userId: tenant.userId, canApprove: true },
      transaction
    );
    const healthAfterExtraOut = await projectHealthService.getProjectHealth(project.id, transaction);
    assert.equal(healthAfterExtraOut.consumedInventoryCost, 1350, '45 sacos * 30 = 1350');
    assert.equal(healthAfterExtraOut.forecastToComplete, 0, 'já consumiu mais do que o committedCost+approvedChanges, nada falta prever');
    assert.equal(healthAfterExtraOut.projectedTotalCost, 1350, 'custo total projetado sobe acima do orçamento só com o consumo de estoque');
    assert.ok(healthAfterExtraOut.projectedMargin < healthAfterOut.projectedMargin, 'margem precisa cair conforme o estoque consumido sobe');
    assert.equal(healthAfterExtraOut.projectedMargin, -350, 'committedCost (1000) - projectedTotalCost (1350) = -350, margem negativa sem nenhum FinancialEntry lançado');

    // Devolução de 5 sacos abate o custo consumido: (45 - 5) * 30 = 1200.
    await inventoryMovementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, projectId: project.id, movementType: 'RETURN', quantity: 5, destinationLocationId: location.id, sourceType: 'MANUAL' }),
      { userId: tenant.userId, canApprove: true },
      transaction
    );
    const healthAfterReturn = await projectHealthService.getProjectHealth(project.id, transaction);
    assert.equal(healthAfterReturn.consumedInventoryCost, 1200, 'devolução deveria abater o custo de estoque consumido pela obra');
    assert.equal(healthAfterReturn.projectedTotalCost, 1200);
    assert.ok(healthAfterReturn.projectedMargin > healthAfterExtraOut.projectedMargin, 'devolução de material melhora a margem projetada');
  });
});

// BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 5, 2026-10-06): wastagePct em
// projectHealth.service.js somava só LossRecord do tipo LOSS, nunca abatendo os RETURN já
// aprovados que apontam pra eles (relatedLossRecordId) — mesmo padrão de "campo financeiro não
// sincronizado com correção" do bug da margem duplicada. Perda devolvida (RETURN) continuava
// contando 100% como desperdício, podendo disparar falso alerta de "desperdício acima de 5%".
test('M6-99: wastagePct abate material devolvido (RETURN), não conta a perda já corrigida', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project } = await createProjectWithApprovedBudget(transaction, { plannedAmount: 1000 });

    const loss = await lossRecordsService.createLossRecord(
      project.id,
      withTenant({ materialDescription: 'Cimento', quantity: 100, estimatedValue: 100, reason: 'Quebra no transporte', idempotencyKey: `loss-${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );
    assert.equal(loss.status, 'APPROVED'); // dentro da alçada padrão, autoaprovado

    const projectHealthService = require('../src/features/construction/projectHealth.service');
    const healthBeforeReturn = await projectHealthService.getProjectHealth(project.id, transaction);
    assert.equal(healthBeforeReturn.kpis.wastagePct, 10); // 100 / 1000 * 100

    // Devolve 100% do material perdido — saldo líquido de perda vira zero.
    await lossRecordsService.returnLossRecord(loss.id, { quantity: 100 }, tenant.userId, transaction);

    const healthAfterReturn = await projectHealthService.getProjectHealth(project.id, transaction);
    assert.equal(
      healthAfterReturn.kpis.wastagePct,
      0,
      'material devolvido não pode continuar contando como desperdício'
    );
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
      withTenant({ reasonCode: 'X', description: 'desc', budgetImpact: 10, scheduleImpactDays: 0, evidenceFileIds: ['99999999-9999-9999-9999-999999999999'], idempotencyKey: `co-${uniqueSuffix()}` }),
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
      withTenant({ reasonCode: 'X', description: 'desc', budgetImpact: 999, scheduleImpactDays: 0, evidenceFileIds: ['99999999-9999-9999-9999-999999999999'], idempotencyKey: `co-${uniqueSuffix()}` }),
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

// GAP CORRIGIDO (auditoria pós-Marco 6, item 4): margem mínima migrada do mecanismo próprio
// (MarginRule) para o Motor de Regras genérico (REG-OBR-001). Confirma que createMarginRule
// cria de verdade uma Rule/RuleVersion em core.rules/core.rule_versions com o código do
// catálogo do contrato, e que rule_version_id do orçamento aponta pra essa RuleVersion real.
test('M6-61/item 4: margem mínima é avaliada via Motor de Regras genérico com o código REG-OBR-001', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { Rule: RuleModel, RuleVersion: RuleVersionModel } = require('../src/models');

    const marginRule = await marginRulesService.createMarginRule(withTenant({ minMarginPct: 18 }), tenant.userId, transaction);

    const rule = await RuleModel.findOne({ where: { code: 'REG-OBR-001', groupId: tenant.groupId, companyId: tenant.companyId }, transaction });
    assert.ok(rule, 'esperava uma Rule real com code="REG-OBR-001" no Motor de Regras genérico');

    const version = await RuleVersionModel.findByPk(marginRule.id, { transaction });
    assert.ok(version, 'marginRule.id deveria ser o id de uma RuleVersion real');
    assert.equal(version.ruleId, rule.id);
    assert.equal(Number(version.actionJson.minMarginPct), 18);
    assert.equal(version.status, 'PUBLISHED');

    const project2 = await projectsService.createProject(withTenant({ name: `HOMO QA Obra REG-OBR-001 ${Date.now()}` }), tenant.userId, transaction);
    const budget2 = await budgetsService.createBudget(project2.id, withTenant({}), tenant.userId, transaction);
    await budgetLinesService.createBudgetLine(project2.id, withTenant({ category: 'X', plannedAmount: 500, budgetId: budget2.id }), tenant.userId, transaction);
    const approved2 = await budgetsService.approveBudget(budget2.id, tenant.userId, transaction);

    const approvedVersion = await RuleVersionModel.findByPk(approved2.ruleVersionId, { transaction });
    assert.ok(approvedVersion, 'budget.ruleVersionId precisa apontar pra uma RuleVersion real do Motor de Regras genérico');
    assert.equal(approvedVersion.ruleId, rule.id);
  });
});

// FIX (auditoria do contrato, Marco 6, 2026-10-07): este teste dependia do tenant de SEED nunca
// ter uma MarginRule configurada — premissa que deixou de valer no momento em que criamos a
// MarginRule padrão de homologação (15%) para a empresa de seed, pra destravar o teste de
// aprovação de orçamento do auditor. A regra de negócio (bloquear aprovação sem margem
// configurada) continua intacta e fail-closed — só o cenário de teste precisa de uma empresa
// nova, de verdade sem NENHUMA MarginRule, em vez de reusar a empresa de seed compartilhada.
test('Aprovar orçamento sem nenhuma margem mínima configurada é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const freshCompany = await Company.create(
      {
        groupId: tenant.groupId,
        name: `HOMO QA Empresa sem margem ${Date.now()}${Math.floor(Math.random() * 10000)}`,
        status: 'ACTIVE',
      },
      { transaction }
    );
    await sequelize.query('SET LOCAL app.company_id = :companyId', {
      replacements: { companyId: freshCompany.id },
      transaction,
    });

    const freshTenant = { ...withTenant({}), groupId: tenant.groupId, companyId: freshCompany.id };
    const project = await projectsService.createProject(
      { ...freshTenant, name: `HOMO QA Obra sem regra ${Date.now()}` },
      tenant.userId,
      transaction
    );
    const budget = await budgetsService.createBudget(project.id, freshTenant, tenant.userId, transaction);
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

  // GAP item 4 (migração pra Motor de Regras genérico): createMarginRule agora cria uma
  // RuleVersion real em core.rule_versions (+ RuleScope/RulePublication), espelhando só o id
  // em construction.margin_rules pra manter a FK legada de budgets.rule_version_id íntegra
  // (ver comentário de topo de marginRules.service.js). Como este teste COMMITA de verdade
  // (precisa de duas conexões reais pra testar concorrência), a limpeza abaixo também precisa
  // apagar as linhas novas do Motor de Regras — senão fica lixo real no banco compartilhado.
  const {
    MarginRule: MarginRuleModel,
    RuleVersion: RuleVersionModel,
    RuleScope: RuleScopeModel,
    RulePublication: RulePublicationModel,
    RuleEvaluationLog: RuleEvaluationLogModel,
  } = require('../src/models');
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
      // marginRuleId === RuleVersion.id criado por este teste (createMarginRule espelha o
      // mesmo id nas duas tabelas) — apaga das duas, inclusive RuleScope/RulePublication.
      await RuleEvaluationLogModel.destroy({ where: { ruleVersionId: marginRuleId }, transaction: t, force: true });
      await RuleScopeModel.destroy({ where: { ruleVersionId: marginRuleId }, transaction: t, force: true });
      await RulePublicationModel.destroy({ where: { ruleVersionId: marginRuleId }, transaction: t, force: true });
      await RuleVersionModel.destroy({ where: { id: marginRuleId }, transaction: t, force: true });
      await MarginRuleModel.destroy({ where: { id: marginRuleId }, transaction: t, force: true });
      if (previouslyActiveRule) {
        await MarginRuleModel.update({ isActive: true }, { where: { id: previouslyActiveRule.id }, transaction: t });
        // A versão anterior do Motor de Regras teve effectiveUntil fechado por este teste —
        // reabre pra devolver o tenant compartilhado ao estado de antes.
        await RuleVersionModel.update({ effectiveUntil: null }, { where: { id: previouslyActiveRule.id }, transaction: t });
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

// Auditoria Marco 6, ciclo 1 (novo): categoria 14 do catálogo — guard numérico só checava
// Number.isNaN, deixando passar o valor especial 'Infinity' aceito pelo Postgres NUMERIC.

test('M6-NOVO-1: createBudgetLine rejeita plannedAmount "Infinity" (categoria 14 do catálogo)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra Infinity ${Date.now()}` }),
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () =>
        budgetLinesService.createBudgetLine(
          project.id,
          withTenant({ category: 'FUNDACAO', plannedAmount: 'Infinity' }),
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'BUDGET_LINE_VALIDATION');
        return true;
      }
    );
  });
});

// BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 10, Frente B, 09/10/2026): createBudgetLine
// nunca comparava budget.projectId com o projectId do contexto — era possível criar uma linha
// na Obra A apontando pra um budgetId que pertence à Obra B.
test('M6-NOVO-7: createBudgetLine recusa budgetId que pertence a outra obra', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const projectA = await projectsService.createProject(withTenant({ name: `HOMO QA Obra A cross-budget ${uniqueSuffix()}` }), tenant.userId, transaction);
    const projectB = await projectsService.createProject(withTenant({ name: `HOMO QA Obra B cross-budget ${uniqueSuffix()}` }), tenant.userId, transaction);
    const budgetB = await budgetsService.createBudget(projectB.id, withTenant({}), tenant.userId, transaction);

    await assert.rejects(
      () => budgetLinesService.createBudgetLine(projectA.id, withTenant({ category: 'X', plannedAmount: 100, budgetId: budgetB.id }), tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'BUDGET_LINE_BUDGET_PROJECT_MISMATCH');
        return true;
      }
    );
  });
});

// BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 12, Frente A, 09/10/2026): createBudget nunca
// comparava project.companyId/groupId com companyId/groupId do payload. RLS já bloqueia
// cross-COMPANY (linha nem fica visível), mas cross-GROUP dentro da MESMA empresa não era
// coberto por RLS (a policy usa só company_id) — dependia só dessa guarda na camada de serviço.
test('M6-NOVO-10: createBudget recusa quando o groupId do payload não bate com o groupId real da obra (mesma empresa, grupo diferente)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { Project: ProjectModel, Group: GroupModel } = require('../src/models');
    const otherGroup = await GroupModel.create({ name: `HOMO QA Grupo outro ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction });
    const projectOfOtherGroup = await ProjectModel.create(
      { groupId: otherGroup.id, companyId: tenant.companyId, name: `HOMO QA Obra outro grupo ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );

    await assert.rejects(
      () => budgetsService.createBudget(projectOfOtherGroup.id, withTenant({}), tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'BUDGET_PROJECT_COMPANY_MISMATCH');
        return true;
      }
    );
  });
});

test('M6-NOVO-2: createChangeOrder rejeita budgetImpact "Infinity" (categoria 14 do catálogo)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project } = await createProjectWithApprovedBudget(transaction, { plannedAmount: 1000 });

    await assert.rejects(
      () =>
        changeOrdersService.createChangeOrder(
          project.id,
          withTenant({ reasonCode: 'ESCOPO', description: 'Teste Infinity', budgetImpact: 'Infinity', scheduleImpactDays: 0, evidenceFileIds: ['99999999-9999-9999-9999-999999999999'], idempotencyKey: `co-${uniqueSuffix()}` }),
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'CHANGE_ORDER_VALIDATION');
        return true;
      }
    );
  });
});

// BUG REAL CORRIGIDO (auditoria externa Nayara, reteste 09/10/2026 — F4): o Caderno (p.163)
// lista scheduleImpactDays e evidenceFileIds no "objeto obrigatório" do Change Order, mas o
// código aceitava ambos ausentes/vazios sem bloquear.
test('M6-NOVO-4: createChangeOrder exige scheduleImpactDays (pode ser 0) e evidenceFileIds não vazio', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project } = await createProjectWithApprovedBudget(transaction, { plannedAmount: 1000 });

    await assert.rejects(
      () =>
        changeOrdersService.createChangeOrder(
          project.id,
          withTenant({ reasonCode: 'ESCOPO', description: 'Sem impacto de prazo informado', budgetImpact: 100, evidenceFileIds: ['99999999-9999-9999-9999-999999999999'], idempotencyKey: `co-${uniqueSuffix()}` }),
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'CHANGE_ORDER_VALIDATION');
        return true;
      }
    );

    await assert.rejects(
      () =>
        changeOrdersService.createChangeOrder(
          project.id,
          withTenant({ reasonCode: 'ESCOPO', description: 'Sem evidência', budgetImpact: 100, scheduleImpactDays: 0, evidenceFileIds: [], idempotencyKey: `co-${uniqueSuffix()}` }),
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'CHANGE_ORDER_VALIDATION');
        return true;
      }
    );

    // Controle positivo: com os dois campos preenchidos (scheduleImpactDays=0 é uma resposta
    // válida — "sem impacto de prazo"), a criação funciona normalmente.
    const changeOrder = await changeOrdersService.createChangeOrder(
      project.id,
      withTenant({ reasonCode: 'ESCOPO', description: 'Aditivo completo', budgetImpact: 100, scheduleImpactDays: 0, evidenceFileIds: ['99999999-9999-9999-9999-999999999999'], idempotencyKey: `co-${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );
    assert.equal(changeOrder.status, 'PENDING_APPROVAL');
  });
});

// BUG REAL CORRIGIDO (auditoria "ciclos até secar", Ciclo 3, Frente C, 09/10/2026): retry de
// rede/duplo-clique no formulário de Change Order criava 2 registros idênticos em
// PENDING_APPROVAL; se ambos fossem aprovados, budgetImpact era aplicado 2x no orçamento.
test('M6-NOVO-5: createChangeOrder exige idempotencyKey, e reenviar a MESMA chave devolve o registro original (sem duplicar aditivo)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project } = await createProjectWithApprovedBudget(transaction, { plannedAmount: 1000 });

    await assert.rejects(
      () =>
        changeOrdersService.createChangeOrder(
          project.id,
          withTenant({ reasonCode: 'ESCOPO', description: 'Sem idempotencyKey', budgetImpact: 100, scheduleImpactDays: 0, evidenceFileIds: ['99999999-9999-9999-9999-999999999999'] }),
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'CHANGE_ORDER_IDEMPOTENCY_KEY_REQUIRED');
        return true;
      }
    );

    const key = `co-retry-${uniqueSuffix()}`;
    const payload = withTenant({ reasonCode: 'ESCOPO', description: 'Reforço estrutural', budgetImpact: 250, scheduleImpactDays: 0, evidenceFileIds: ['99999999-9999-9999-9999-999999999999'], idempotencyKey: key });

    const first = await changeOrdersService.createChangeOrder(project.id, payload, tenant.userId, transaction);
    const second = await changeOrdersService.createChangeOrder(project.id, payload, tenant.userId, transaction);
    assert.equal(second.id, first.id, 'reenviar a mesma idempotencyKey deve devolver o registro original, não criar um novo Change Order');

    const all = await changeOrdersService.listChangeOrders(project.id, transaction);
    const withKey = all.filter((co) => co.idempotencyKey === key);
    assert.equal(withKey.length, 1, 'não pode existir mais de um Change Order com a mesma idempotencyKey');
  });
});

// BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 12, Frente A, 09/10/2026): createChangeOrder
// nunca comparava project.companyId/groupId com companyId/groupId do payload. RLS já bloqueia
// cross-COMPANY, mas cross-GROUP dentro da MESMA empresa não era coberto (a policy usa só
// company_id) — dependia só dessa guarda na camada de serviço.
test('M6-NOVO-11: createChangeOrder recusa quando o groupId do payload não bate com o groupId real da obra (mesma empresa, grupo diferente)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { Project: ProjectModel, Group: GroupModel } = require('../src/models');
    const otherGroup = await GroupModel.create({ name: `HOMO QA Grupo outro CO ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction });
    const projectOfOtherGroup = await ProjectModel.create(
      { groupId: otherGroup.id, companyId: tenant.companyId, name: `HOMO QA Obra outro grupo CO ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );

    await assert.rejects(
      () =>
        changeOrdersService.createChangeOrder(
          projectOfOtherGroup.id,
          withTenant({ reasonCode: 'ESCOPO', description: 'Cross-group', budgetImpact: 100, scheduleImpactDays: 0, evidenceFileIds: ['99999999-9999-9999-9999-999999999999'], idempotencyKey: `co-cross-group-${uniqueSuffix()}` }),
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'CHANGE_ORDER_PROJECT_COMPANY_MISMATCH');
        return true;
      }
    );
  });
});

// BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 18): createProject nunca validava
// "budgetAmount" (Number.isFinite/não-negativo/teto) — só updateProject tinha essa validação
// pro MESMO campo. Como a coluna é NUMERIC(18,2) e o Postgres aceita o literal 'NaN' pra esse
// tipo, "budgetAmount": "NaN" na CRIAÇÃO da obra persistia corrompido silenciosamente.
test('M6-NOVO-3: createProject rejeita budgetAmount "NaN"/"Infinity"/negativo/absurdamente grande', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    for (const badValue of ['NaN', 'Infinity', -500, 2_000_000_000_000]) {
      await assert.rejects(
        () =>
          projectsService.createProject(
            withTenant({ name: `Obra budgetAmount inválido ${badValue}`, budgetAmount: badValue }),
            tenant.userId,
            transaction
          ),
        (err) => {
          assert.ok(err instanceof AppError);
          assert.ok(['PROJECT_BUDGET_AMOUNT_INVALID', 'PROJECT_BUDGET_AMOUNT_TOO_LARGE'].includes(err.code));
          return true;
        }
      );
    }

    // Caminho feliz: valor válido é aceito e persistido como número.
    const ok = await projectsService.createProject(
      withTenant({ name: `Obra budgetAmount válido ${Date.now()}`, budgetAmount: 15000.5 }),
      tenant.userId,
      transaction
    );
    assert.equal(Number(ok.budgetAmount), 15000.5);
  });
});

// TAREFA 2 (auditoria externa Nayara, fechamento Marco 6): "economia" (economyPct) e
// "comissão" (commissionPct) da obra — campos opcionais da regra de margem, persistidos via
// Motor de Regras genérico (core.rule_versions.action_json, ver marginRules.service.js),
// recuperados via getActiveMarginRule, com a MESMA validação já existente pra minMarginPct
// (NaN/Infinity/negativo/>100 rejeitados).
test('TAREFA 2: economyPct e commissionPct são salvos e recuperados em createMarginRule/getActiveMarginRule', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const created = await marginRulesService.createMarginRule(
      withTenant({ minMarginPct: 15, economyPct: 8.5, commissionPct: 3.25 }),
      tenant.userId,
      transaction
    );
    assert.equal(created.economyPct, 8.5);
    assert.equal(created.commissionPct, 3.25);

    const active = await marginRulesService.getActiveMarginRule(tenant.groupId, tenant.companyId, transaction);
    assert.equal(active.id, created.id);
    assert.equal(active.minMarginPct, 15);
    assert.equal(active.economyPct, 8.5);
    assert.equal(active.commissionPct, 3.25);

    // Confirma persistência real na fonte da verdade (core.rule_versions.action_json), não só
    // no objeto em memória devolvido pelo service.
    const { RuleVersion: RuleVersionModel } = require('../src/models');
    const version = await RuleVersionModel.findByPk(created.id, { transaction });
    assert.equal(Number(version.actionJson.economyPct), 8.5);
    assert.equal(Number(version.actionJson.commissionPct), 3.25);
  });
});

test('TAREFA 2: economyPct/commissionPct são opcionais (ausentes = null, não quebra criação)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const created = await marginRulesService.createMarginRule(withTenant({ minMarginPct: 11 }), tenant.userId, transaction);
    assert.equal(created.economyPct, null);
    assert.equal(created.commissionPct, null);

    const active = await marginRulesService.getActiveMarginRule(tenant.groupId, tenant.companyId, transaction);
    assert.equal(active.economyPct, null);
    assert.equal(active.commissionPct, null);
  });
});

test('TAREFA 2: economyPct/commissionPct rejeitam NaN/Infinity/negativo/>100 (mesma validação de minMarginPct)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    for (const badValue of ['NaN', 'Infinity', -1, 101]) {
      await assert.rejects(
        () => marginRulesService.createMarginRule(withTenant({ minMarginPct: 10, economyPct: badValue }), tenant.userId, transaction),
        (err) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'MARGIN_RULE_VALIDATION');
          return true;
        }
      );
      await assert.rejects(
        () => marginRulesService.createMarginRule(withTenant({ minMarginPct: 10, commissionPct: badValue }), tenant.userId, transaction),
        (err) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'MARGIN_RULE_VALIDATION');
          return true;
        }
      );
    }
  });
});

// TAREFA 3 (auditoria externa Nayara, fechamento Marco 6): projectHealth.service.js já calcula
// `belowMinMargin` (linhas ~196-206), mas não tinha teste dedicado forçando esse caminho a
// true. Cria obra com margem mínima configurada ALTA (30%) e orçamento com custo que deixa a
// margem projetada abaixo disso (custo realizado alto o suficiente pra corroer a margem),
// chama getProjectHealth real e confirma belowMinMargin === true.
test('TAREFA 3: getProjectHealth retorna belowMinMargin=true quando a margem projetada fica abaixo da regra mínima', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const projectHealthService = require('../src/features/construction/projectHealth.service');
    const { FinancialEntry } = require('../src/models');

    // Margem mínima exigida bem alta (30%) — qualquer margem projetada abaixo disso deve
    // disparar o alerta.
    await marginRulesService.createMarginRule(withTenant({ minMarginPct: 30 }), tenant.userId, transaction);

    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra belowMinMargin ${Date.now()}${Math.floor(Math.random() * 10000)}` }),
      tenant.userId,
      transaction
    );
    const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
    // Base orçada de 1000 (committedCost); custo realizado via Financeiro de 950 — margem
    // projetada fica em torno de 5%, bem abaixo dos 30% mínimos exigidos.
    await budgetLinesService.createBudgetLine(
      project.id,
      withTenant({ category: 'FUNDACAO', plannedAmount: 1000, budgetId: budget.id }),
      tenant.userId,
      transaction
    );
    await budgetsService.approveBudget(budget.id, tenant.userId, transaction);

    await FinancialEntry.create(
      withTenant({
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        status: 'SETTLED',
        amount: 950,
        constructionProjectId: project.id,
        description: 'Custo realizado alto — força margem abaixo do mínimo (TAREFA 3)',
        dueAt: new Date(),
        settledAt: new Date(),
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      }),
      { transaction }
    );

    const health = await projectHealthService.getProjectHealth(project.id, transaction);

    assert.equal(health.minMarginPct, 30);
    assert.ok(health.marginPct !== null, 'marginPct não deveria ser null com orçamento aprovado');
    assert.ok(health.marginPct < 30, `esperava marginPct < 30, recebeu ${health.marginPct}`);
    assert.equal(health.belowMinMargin, true);
  });
});

// TAREFA (auditoria externa Nayara, item A9/caderno técnico p.161 seção 5): "Margem abaixo da
// regra gera alerta ou bloqueio, conforme configurado" — até esta auditoria só existia o
// ALERTA (belowMinMargin, nunca bloqueava nada). Estes testes cobrem o novo `enforcementMode`
// ('ALERT' default preserva o comportamento antigo / 'BLOCK' impede a aprovação de verdade) nos
// dois pontos de decisão reais: approveBudget (budgets.service.js) e decideChangeOrder
// (changeOrders.service.js). Mesma fórmula de margem do TAREFA 3 acima: sem nenhum custo
// realizado/estoque consumido ainda, projectedMargin fica em 0 (forecastToComplete cobre
// exatamente o que falta) — ou seja, qualquer minMarginPct > 0 já configura "abaixo da regra" na
// aprovação; minMarginPct = 0 é o caso-limite "margem acima/igual ao mínimo", usado para provar
// que o BLOCK não bloqueia à toa.

test('ENFORCEMENT: enforcementMode=BLOCK recusa approveBudget quando a margem projetada fica abaixo do mínimo configurado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await marginRulesService.createMarginRule(
      withTenant({ minMarginPct: 30, enforcementMode: 'BLOCK' }),
      tenant.userId,
      transaction
    );

    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra enforcement block budget ${Date.now()}${Math.floor(Math.random() * 10000)}` }),
      tenant.userId,
      transaction
    );
    const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
    await budgetLinesService.createBudgetLine(
      project.id,
      withTenant({ category: 'FUNDACAO', plannedAmount: 1000, budgetId: budget.id }),
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => budgetsService.approveBudget(budget.id, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'BUDGET_APPROVAL_BLOCKED_BY_MARGIN_RULE');
        return true;
      }
    );

    const reloaded = await budgetsService.getBudget(budget.id, transaction);
    assert.equal(reloaded.status, 'DRAFT', 'orçamento não pode ter sido aprovado quando o bloqueio dispara');
  });
});

test('ENFORCEMENT: enforcementMode=ALERT (explícito) ou ausente (default) aprova o orçamento normalmente e só sinaliza belowMinMargin no health', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // Explícito 'ALERT'.
    await marginRulesService.createMarginRule(
      withTenant({ minMarginPct: 30, enforcementMode: 'ALERT' }),
      tenant.userId,
      transaction
    );

    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra enforcement alert budget ${Date.now()}${Math.floor(Math.random() * 10000)}` }),
      tenant.userId,
      transaction
    );
    const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
    await budgetLinesService.createBudgetLine(
      project.id,
      withTenant({ category: 'FUNDACAO', plannedAmount: 1000, budgetId: budget.id }),
      tenant.userId,
      transaction
    );

    const approved = await budgetsService.approveBudget(budget.id, tenant.userId, transaction);
    assert.equal(approved.status, 'APPROVED', 'enforcementMode ALERT nunca pode bloquear a aprovação');

    const projectHealthService = require('../src/features/construction/projectHealth.service');
    const health = await projectHealthService.getProjectHealth(project.id, transaction);
    assert.equal(health.minMarginPct, 30);
    assert.equal(health.belowMinMargin, true, 'alerta continua ativo mesmo sem bloquear');

    // Default (campo ausente) — mesmo resultado: nunca bloqueia.
    await marginRulesService.createMarginRule(withTenant({ minMarginPct: 30 }), tenant.userId, transaction);

    const project2 = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra enforcement default budget ${Date.now()}${Math.floor(Math.random() * 10000)}` }),
      tenant.userId,
      transaction
    );
    const budget2 = await budgetsService.createBudget(project2.id, withTenant({}), tenant.userId, transaction);
    await budgetLinesService.createBudgetLine(
      project2.id,
      withTenant({ category: 'FUNDACAO', plannedAmount: 1000, budgetId: budget2.id }),
      tenant.userId,
      transaction
    );
    const approved2 = await budgetsService.approveBudget(budget2.id, tenant.userId, transaction);
    assert.equal(approved2.status, 'APPROVED', 'default (sem enforcementMode) precisa continuar sendo ALERT, nunca bloqueia');
  });
});

test('ENFORCEMENT: enforcementMode=BLOCK não bloqueia à toa quando a margem projetada está acima/igual ao mínimo configurado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // minMarginPct=0: sem nenhum custo realizado ainda, projectedMargin=0 (ver comentário acima)
    // — 0 não é "abaixo de 0", então o BLOCK não pode disparar.
    await marginRulesService.createMarginRule(
      withTenant({ minMarginPct: 0, enforcementMode: 'BLOCK' }),
      tenant.userId,
      transaction
    );

    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra enforcement block ok ${Date.now()}${Math.floor(Math.random() * 10000)}` }),
      tenant.userId,
      transaction
    );
    const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
    await budgetLinesService.createBudgetLine(
      project.id,
      withTenant({ category: 'FUNDACAO', plannedAmount: 1000, budgetId: budget.id }),
      tenant.userId,
      transaction
    );

    const approved = await budgetsService.approveBudget(budget.id, tenant.userId, transaction);
    assert.equal(approved.status, 'APPROVED', 'margem igual/acima do mínimo não pode ser bloqueada');
  });
});

test('ENFORCEMENT: enforcementMode=BLOCK recusa decideChangeOrder(APPROVE) quando a margem projetada fica abaixo do mínimo configurado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // Orçamento aprovado com a regra default (ALERT) do helper — sem bloqueio na aprovação do
    // orçamento em si.
    const { project } = await createProjectWithApprovedBudget(transaction, { plannedAmount: 1000 });

    // Troca a regra vigente para BLOCK/minMarginPct alto ANTES de decidir o Change Order —
    // decideChangeOrder sempre lê a regra ATIVA no momento da decisão (getActiveMarginRule),
    // nunca uma versão congelada.
    await marginRulesService.createMarginRule(
      withTenant({ minMarginPct: 30, enforcementMode: 'BLOCK' }),
      tenant.userId,
      transaction
    );

    const changeOrder = await changeOrdersService.createChangeOrder(
      project.id,
      withTenant({ reasonCode: 'ESCOPO_ADICIONAL', description: 'Reforço estrutural não previsto', budgetImpact: 250, scheduleImpactDays: 0, evidenceFileIds: ['99999999-9999-9999-9999-999999999999'], idempotencyKey: `co-${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => changeOrdersService.decideChangeOrder(changeOrder.id, { decision: 'APPROVE' }, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'CHANGE_ORDER_APPROVAL_BLOCKED_BY_MARGIN_RULE');
        return true;
      }
    );

    const reloaded = await changeOrdersService.getChangeOrder(changeOrder.id, transaction);
    assert.equal(reloaded.status, 'PENDING_APPROVAL', 'Change Order não pode ter sido aprovado quando o bloqueio dispara');
  });
});

test('ENFORCEMENT: enforcementMode=ALERT permite decideChangeOrder(APPROVE) normalmente mesmo com margem abaixo do mínimo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project } = await createProjectWithApprovedBudget(transaction, { plannedAmount: 1000 });

    await marginRulesService.createMarginRule(
      withTenant({ minMarginPct: 30, enforcementMode: 'ALERT' }),
      tenant.userId,
      transaction
    );

    const changeOrder = await changeOrdersService.createChangeOrder(
      project.id,
      withTenant({ reasonCode: 'ESCOPO_ADICIONAL', description: 'Reforço estrutural não previsto', budgetImpact: 250, scheduleImpactDays: 0, evidenceFileIds: ['99999999-9999-9999-9999-999999999999'], idempotencyKey: `co-${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );

    const decided = await changeOrdersService.decideChangeOrder(changeOrder.id, { decision: 'APPROVE' }, tenant.userId, transaction);
    assert.equal(decided.status, 'APPROVED', 'enforcementMode ALERT nunca pode bloquear a aprovação de Change Order');

    const projectHealthService = require('../src/features/construction/projectHealth.service');
    const health = await projectHealthService.getProjectHealth(project.id, transaction);
    assert.equal(health.belowMinMargin, true, 'alerta continua ativo mesmo sem bloquear');
  });
});

test('ENFORCEMENT: enforcementMode=BLOCK não bloqueia decideChangeOrder(APPROVE) quando a margem projetada está acima/igual ao mínimo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project } = await createProjectWithApprovedBudget(transaction, { plannedAmount: 1000 });

    await marginRulesService.createMarginRule(
      withTenant({ minMarginPct: 0, enforcementMode: 'BLOCK' }),
      tenant.userId,
      transaction
    );

    const changeOrder = await changeOrdersService.createChangeOrder(
      project.id,
      withTenant({ reasonCode: 'ESCOPO_ADICIONAL', description: 'Reforço estrutural não previsto', budgetImpact: 250, scheduleImpactDays: 0, evidenceFileIds: ['99999999-9999-9999-9999-999999999999'], idempotencyKey: `co-${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );

    const decided = await changeOrdersService.decideChangeOrder(changeOrder.id, { decision: 'APPROVE' }, tenant.userId, transaction);
    assert.equal(decided.status, 'APPROVED', 'margem igual/acima do mínimo não pode ser bloqueada');
  });
});
