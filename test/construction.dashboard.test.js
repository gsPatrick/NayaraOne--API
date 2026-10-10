'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const budgetsService = require('../src/features/construction/budgets.service');
const budgetLinesService = require('../src/features/construction/budgetLines.service');
const marginRulesService = require('../src/features/construction/marginRules.service');
const maintenanceCasesService = require('../src/features/construction/maintenanceCases.service');
const { getConstructionDashboard } = require('../src/features/construction/dashboard.service');
const { Property, BudgetLine, MaintenanceCase, WarrantyAction } = require('../src/models');
const { columnsExist } = require('../src/features/construction/warrantyActionTeamMaterialColumns');

// GAP CORRIGIDO (auditoria pós-Marco 6, item 1): o contrato exige dois painéis de BI dedicados
// — "Obras" e "Pós-obra" — com dado agregado de TODAS as obras da empresa, não só o
// drill-down de uma obra (já existente em getProjectHealth). Estes testes confirmam que o novo
// read model agrega corretamente através de múltiplas obras/casos de garantia.
//
// GAP CORRIGIDO (auditoria pós-Marco 6, item 3): os testes abaixo NÃO comparam mais "contagem
// de TODOS os projetos da empresa antes vs depois" — num banco de desenvolvimento compartilhado,
// outro processo (ex. E2E Playwright ao vivo rodando em paralelo) pode inserir/commitar dados
// na MESMA empresa semente entre o snapshot "before" e o snapshot "after" desta mesma
// transação (READ COMMITTED enxerga comrotados de outras conexões), inflando a diferença e
// tornando o teste flakey — não é bug do dashboard, é fragilidade do teste. Agora cada teste
// cria projetos/recursos com nome único (`uniqueSuffix()`) e valida reconstruindo o valor
// ESPERADO com uma query direta filtrada pelos MESMOS IDs que o próprio teste criou, comparando
// contra o campo agregado do dashboard — nunca depende de "quantos existiam antes".

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

test('dashboard: getConstructionDashboard agrega baseline/committed de MÚLTIPLAS obras, não só uma', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await marginRulesService.createMarginRule(withTenant({ minMarginPct: 10 }), tenant.userId, transaction);

    const suffix = uniqueSuffix();
    const projectA = await projectsService.createProject(withTenant({ name: `Dash Obra A ${suffix}` }), tenant.userId, transaction);
    const budgetA = await budgetsService.createBudget(projectA.id, withTenant({}), tenant.userId, transaction);
    await budgetLinesService.createBudgetLine(projectA.id, withTenant({ category: 'X', plannedAmount: 300, budgetId: budgetA.id }), tenant.userId, transaction);
    await budgetsService.approveBudget(budgetA.id, tenant.userId, transaction);

    const projectB = await projectsService.createProject(withTenant({ name: `Dash Obra B ${suffix}` }), tenant.userId, transaction);
    const budgetB = await budgetsService.createBudget(projectB.id, withTenant({}), tenant.userId, transaction);
    await budgetLinesService.createBudgetLine(projectB.id, withTenant({ category: 'Y', plannedAmount: 700, budgetId: budgetB.id }), tenant.userId, transaction);
    await budgetsService.approveBudget(budgetB.id, tenant.userId, transaction);

    // Valor esperado reconstruído de forma independente, filtrado pelos próprios IDs criados
    // pelo teste — nunca depende de quantos projetos/linhas já existiam na empresa semente.
    const ourLines = await BudgetLine.findAll({
      where: { projectId: { [Op.in]: [projectA.id, projectB.id] } },
      transaction,
    });
    const ourCommittedSum = ourLines.reduce((acc, l) => acc + Number(l.plannedAmount), 0);
    assert.equal(ourCommittedSum, 1000, 'sanity: as duas linhas criadas pelo teste somam 300 + 700');

    const dashboard = await getConstructionDashboard({ groupId: tenant.groupId, companyId: tenant.companyId }, transaction);

    // Soma TOTAL da empresa (dashboard) precisa incluir pelo menos os 1000 dos nossos projetos
    // — comparação por "contém", não por diff contra um snapshot anterior sujeito a corrida.
    assert.ok(
      dashboard.obras.committedCostTotal >= ourCommittedSum,
      'committedCostTotal da empresa precisa, no mínimo, incluir a soma das linhas dos projetos criados pelo teste'
    );
    // Reconstrução independente do total esperado, via query direta na MESMA transação/
    // visibilidade do dashboard — nunca um "antes vs depois" global.
    const { data: allCompanyProjects } = await projectsService.listProjects(transaction, { pageSize: 200 });
    const allCompanyLines = await BudgetLine.findAll({
      where: { projectId: { [Op.in]: allCompanyProjects.map((p) => p.id) } },
      transaction,
    });
    const expectedCommittedTotal = allCompanyLines.reduce((acc, l) => acc + Number(l.plannedAmount), 0);
    assert.equal(
      Math.round(dashboard.obras.committedCostTotal * 100),
      Math.round(expectedCommittedTotal * 100),
      'committedCostTotal do dashboard precisa bater com a soma recalculada na mesma visibilidade de transação'
    );
    assert.ok(allCompanyProjects.some((p) => p.id === projectA.id) && allCompanyProjects.some((p) => p.id === projectB.id));
  });
});

// BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 5, Frente C, 09/10/2026): o agregado calculava
// forecastToCompleteTotal/projectedTotalCostTotal/projectedMarginTotal SEM consumedInventoryCost,
// diferente da fórmula canônica em projectHealth.service.js#computeMarginProjection — para obra
// com consumo de estoque real, o painel agregado subestimava custo e inflava margem exibida.
test('dashboard: projectedMarginTotal/projectedTotalCostTotal consideram consumedInventoryCost (mesma fórmula do drill-down por obra)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { InventoryItem, InventoryLocation } = require('../src/models');
    const inventoryMovementsService = require('../src/features/inventory/movements.service');

    await marginRulesService.createMarginRule(withTenant({ minMarginPct: 10 }), tenant.userId, transaction);

    const suffix = uniqueSuffix();
    const project = await projectsService.createProject(withTenant({ name: `Dash Obra Estoque ${suffix}` }), tenant.userId, transaction);
    const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
    await budgetLinesService.createBudgetLine(project.id, withTenant({ category: 'X', plannedAmount: 1000, budgetId: budget.id }), tenant.userId, transaction);
    await budgetsService.approveBudget(budget.id, tenant.userId, transaction);

    const location = await InventoryLocation.create(
      withTenant({ name: `Dash Deposito ${suffix}`, locationType: 'WAREHOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }),
      { transaction }
    );
    const item = await InventoryItem.create(
      withTenant({ name: `Dash Cimento ${suffix}`, unitOfMeasure: 'saco', itemType: 'CONSUMABLE', averageCost: 30, allowNegativeStock: true, createdBy: tenant.userId, updatedBy: tenant.userId }),
      { transaction }
    );
    await inventoryMovementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 100, destinationLocationId: location.id }),
      { userId: tenant.userId, canApprove: true },
      transaction
    );
    // 45 sacos a R$30 = R$1350 consumidos pela obra — mais do que o committedCost (1000),
    // exatamente o cenário que expõe o viés: sem consumedInventoryCost, forecastToComplete
    // zera (Math.max(1000-0,0)=1000... mas projectedTotalCost ficaria só 0, inflando a margem).
    await inventoryMovementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, projectId: project.id, movementType: 'OUT', quantity: 45, sourceLocationId: location.id, sourceType: 'MANUAL' }),
      { userId: tenant.userId, canApprove: true },
      transaction
    );

    const projectHealthService = require('../src/features/construction/projectHealth.service');
    const health = await projectHealthService.getProjectHealth(project.id, transaction);
    assert.equal(health.consumedInventoryCost, 1350);
    assert.equal(health.projectedTotalCost, 1350, 'drill-down por obra: custo projetado já reflete o consumo de estoque');
    assert.equal(health.projectedMargin, -350, 'drill-down por obra: margem negativa real (consumiu 1350 de um orçado de 1000)');

    const dashboard = await getConstructionDashboard({ groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
    assert.ok(
      dashboard.obras.consumedInventoryCostTotal >= 1350,
      'consumedInventoryCostTotal do painel agregado precisa, no mínimo, incluir o consumo de estoque desta obra'
    );
    // Prova de que a fórmula do agregado está correta e não apenas "exposta sem efeito": a
    // margem projetada total não pode estar inflada a ponto de ignorar o estoque consumido —
    // ou seja, o custo total projetado agregado precisa ser >= realizedCost desta obra sozinha
    // (actualFinancialCost=0 + consumedInventoryCost=1350), senão o agregado estaria
    // subestimando o custo real da empresa.
    assert.ok(
      dashboard.obras.projectedTotalCostTotal >= 1350,
      'projectedTotalCostTotal do painel agregado precisa refletir o consumo de estoque desta obra, não só o custo financeiro lançado'
    );
  });
});

// BUG REAL CORRIGIDO (auditoria externa Nayara/ChatGPT, reteste 10/10/2026 — F2, estendido ao
// agregado): a fórmula antiga do dashboard (igual à antiga de projectHealth.service.js) nunca
// conseguia mostrar projectedMarginTotal positiva — reaplicando a mesma lógica EAC por obra
// (agora usada em computeMarginProjection) ANTES de agregar, o painel da empresa consegue
// refletir economia real quando pelo menos uma obra está rendendo mais barato que o orçado.
test('dashboard: projectedMarginTotal consegue ficar POSITIVA quando a obra agregada está gastando menos por % concluído do que o orçado (EAC, mesma fórmula do drill-down)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const projectStagesService = require('../src/features/construction/projectStages.service');
    const stageMeasurementsService = require('../src/features/construction/stageMeasurements.service');
    const financialEntriesService = require('../src/features/finance/financialEntries.service');
    const { FinancialEntry } = require('../src/models');

    await marginRulesService.createMarginRule(withTenant({ minMarginPct: 0 }), tenant.userId, transaction);

    const suffix = uniqueSuffix();
    const project = await projectsService.createProject(withTenant({ name: `Dash Obra EAC positiva ${suffix}` }), tenant.userId, transaction);
    const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
    await budgetLinesService.createBudgetLine(project.id, withTenant({ category: 'X', plannedAmount: 1000, budgetId: budget.id }), tenant.userId, transaction);
    await budgetsService.approveBudget(budget.id, tenant.userId, transaction);

    // Snapshot ANTES de medir/liquidar o custo real — a obra já existe (budget aprovado) mas
    // ainda contribui com margem 0 ao agregado (sem progresso/custo real lançado ainda).
    const dashboardBefore = await getConstructionDashboard({ groupId: tenant.groupId, companyId: tenant.companyId }, transaction);

    // Mesmo cenário do teste de drill-down: 50% concluído, 400 gasto — EAC=800, economia=200.
    const stage = await projectStagesService.createProjectStage(project.id, withTenant({ name: 'Fundação' }), tenant.userId, transaction);
    await projectStagesService.updateProjectStage(stage.id, { measuredPct: 50 }, tenant.userId, transaction);
    const measurement = await stageMeasurementsService.createStageMeasurement(
      stage.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, measuredPct: 50, measuredAt: '2026-10-01', items: [{ description: 'Serviço executado', quantity: 1, unitPrice: 400 }] },
      tenant.userId,
      transaction
    );
    await stageMeasurementsService.submitStageMeasurement(measurement.id, tenant.userId, transaction);
    await stageMeasurementsService.reviewStageMeasurement(measurement.id, {}, tenant.userId, transaction);
    await stageMeasurementsService.decideStageMeasurement(measurement.id, { decision: 'APPROVED' }, tenant.userId, transaction);
    const entry = await FinancialEntry.findOne({ where: { idempotencyKey: `measurement.payable:${measurement.id}` }, transaction });
    await financialEntriesService.settleFinancialEntry(entry.id, tenant.userId, transaction);

    const projectHealthService = require('../src/features/construction/projectHealth.service');
    const health = await projectHealthService.getProjectHealth(project.id, transaction);
    assert.equal(health.projectedMargin, 200, 'sanity: drill-down desta obra sozinha já mostra margem positiva');

    // Banco de dev compartilhado: não afirma um valor absoluto da empresa inteira (outras obras
    // concorrentes podem ter margem negativa arrastando o total pra baixo). Mede o DELTA
    // causado só por esta obra (snapshot ANTES de medir/liquidar o custo real vs DEPOIS, dentro
    // da MESMA transação) — isolado de qualquer dado pré-existente/concorrente.
    const dashboardAfter = await getConstructionDashboard({ groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
    const delta = Math.round((dashboardAfter.obras.projectedMarginTotal - dashboardBefore.obras.projectedMarginTotal) * 100) / 100;
    assert.equal(
      delta,
      200,
      `a contribuição desta obra ao agregado precisa ser +200 (economia real), recebeu delta=${delta} — a fórmula antiga nunca conseguia contribuir com valor positivo`
    );
  });
});

test('dashboard: posObra agrega chamados de garantia de MÚLTIPLAS obras e quebra recorrência por causa/equipe/material', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const project = await projectsService.createProject(withTenant({ name: `Dash Obra PosObra ${suffix}` }), tenant.userId, transaction);
    const property = await Property.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel Dash ${suffix}`,
        internalCode: `DASH-${suffix}`,
        propertyType: 'HOUSE',
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );

    // rootCauseCode é um enum controlado (MATERIAL_DEFECT, WORKMANSHIP, DESIGN_FLAW, MISUSE,
    // NATURAL_WEAR, OTHER) — não dá pra sufixar com uniqueSuffix() como os outros campos livres
    // deste teste. Em vez disso, a asserção de recorrência por causa compara a CONTAGEM
    // recalculada via query direta (filtrada por esta causa) contra a entrada do dashboard,
    // nunca um "antes vs depois" global — robusto mesmo que outros processos usem a mesma causa.
    const rootCause = 'DESIGN_FLAW';
    const maintenanceCase = await maintenanceCasesService.createMaintenanceCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        projectId: project.id,
        description: `Infiltração — dashboard ${suffix}`,
        severity: 'HIGH',
        rootCauseCode: rootCause,
      },
      tenant.userId,
      transaction
    );

    // GAP CORRIGIDO (item 2): WarrantyAction agora carrega assignedTeam/materialUsed.
    const teamName = `Equipe Hidráulica ${suffix}`;
    const materialName = `Rejunte impermeável ${suffix}`;
    await maintenanceCasesService.createWarrantyAction(
      maintenanceCase.id,
      { description: `Reparo infiltração ${suffix}`, cost: 150, assignedTeam: teamName, materialUsed: materialName },
      tenant.userId,
      transaction
    );

    const dashboard = await getConstructionDashboard({ groupId: tenant.groupId, companyId: tenant.companyId }, transaction);

    // Reconstrução independente (não um diff antes/depois global): confirma que o CASO criado
    // por este teste aparece na recorrência por causa, e a AÇÃO criada aparece na recorrência
    // por equipe e por material.
    const casesWithOurCause = await MaintenanceCase.count({ where: { rootCauseCode: rootCause }, transaction });
    const causeEntry = dashboard.posObra.recurrenceByRootCause.find((r) => r.cause === rootCause);
    assert.ok(causeEntry, 'recurrenceByRootCause precisa conter a causa específica criada pelo teste');
    assert.equal(causeEntry.count, casesWithOurCause);

    const actionsForOurCase = await WarrantyAction.findAll({ where: { warrantyCaseId: maintenanceCase.id }, transaction });
    assert.equal(actionsForOurCase.length, 1);

    // Item 2 depende da migration 20260101000296 (assigned_team/material_used em
    // construction.warranty_actions), que precisa de credencial de admin pra rodar — ainda não
    // aplicada neste ambiente. Enquanto isso o helper fica fail-open (recurrenceByTeam/Material
    // vazios); a asserção forte só roda quando a coluna já existir, pra este teste validar de
    // ponta a ponta automaticamente no dia em que a migration for aplicada, sem precisar reescrever.
    if (await columnsExist(transaction)) {
      const teamEntry = dashboard.posObra.recurrenceByTeam.find((r) => r.team === teamName);
      assert.ok(teamEntry, 'recurrenceByTeam precisa conter a equipe específica criada pelo teste (item 2)');
      assert.equal(teamEntry.count, 1);

      const materialEntry = dashboard.posObra.recurrenceByMaterial.find((r) => r.material === materialName);
      assert.ok(materialEntry, 'recurrenceByMaterial precisa conter o material específico criado pelo teste (item 2)');
      assert.equal(materialEntry.count, 1);
    } else {
      // BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 10, Frente A — teste mente, 09/10/2026):
      // comparar a variável contra ela mesma é tautológico — passa sempre, mesmo se
      // recurrenceByTeam/Material estivessem quebrados (undefined, formato errado). Sem a
      // coluna, getTeamAndMaterialByActionIds fica fail-open (Map vazio) e o agregador usa a
      // chave 'DESCONHECIDA' pra toda ação — confirma essa estrutura real, não uma tautologia.
      assert.ok(Array.isArray(dashboard.posObra.recurrenceByTeam), 'recurrenceByTeam precisa ser um array mesmo no caminho fail-open');
      assert.ok(Array.isArray(dashboard.posObra.recurrenceByMaterial), 'recurrenceByMaterial precisa ser um array mesmo no caminho fail-open');
      assert.ok(
        !dashboard.posObra.recurrenceByTeam.some((r) => r.team === teamName),
        'sem a coluna assigned_team, a equipe específica criada pelo teste não pode aparecer nomeada no agregado'
      );
      const desconhecidaEntry = dashboard.posObra.recurrenceByTeam.find((r) => r.team === 'DESCONHECIDA');
      assert.ok(desconhecidaEntry, 'sem a coluna, a ação criada pelo teste precisa cair no bucket fail-open "DESCONHECIDA"');
      assert.ok(desconhecidaEntry.count >= 1);
    }
  });
});
