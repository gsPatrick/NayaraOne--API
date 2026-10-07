'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const budgetsService = require('../src/features/construction/budgets.service');
const budgetLinesService = require('../src/features/construction/budgetLines.service');
const marginRulesService = require('../src/features/construction/marginRules.service');
const maintenanceCasesService = require('../src/features/construction/maintenanceCases.service');
const { getConstructionDashboard } = require('../src/features/construction/dashboard.service');
const { Property } = require('../src/models');

// GAP CORRIGIDO (auditoria pós-Marco 6, item 1): o contrato exige dois painéis de BI dedicados
// — "Obras" e "Pós-obra" — com dado agregado de TODAS as obras da empresa, não só o
// drill-down de uma obra (já existente em getProjectHealth). Estes testes confirmam que o novo
// read model agrega corretamente através de múltiplas obras/casos de garantia.

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

    const before = await getConstructionDashboard({ groupId: tenant.groupId, companyId: tenant.companyId }, transaction);

    const projectA = await projectsService.createProject(withTenant({ name: `Dash Obra A ${Date.now()}` }), tenant.userId, transaction);
    const budgetA = await budgetsService.createBudget(projectA.id, withTenant({}), tenant.userId, transaction);
    await budgetLinesService.createBudgetLine(projectA.id, withTenant({ category: 'X', plannedAmount: 300, budgetId: budgetA.id }), tenant.userId, transaction);
    await budgetsService.approveBudget(budgetA.id, tenant.userId, transaction);

    const projectB = await projectsService.createProject(withTenant({ name: `Dash Obra B ${Date.now()}` }), tenant.userId, transaction);
    const budgetB = await budgetsService.createBudget(projectB.id, withTenant({}), tenant.userId, transaction);
    await budgetLinesService.createBudgetLine(projectB.id, withTenant({ category: 'Y', plannedAmount: 700, budgetId: budgetB.id }), tenant.userId, transaction);
    await budgetsService.approveBudget(budgetB.id, tenant.userId, transaction);

    const after = await getConstructionDashboard({ groupId: tenant.groupId, companyId: tenant.companyId }, transaction);

    assert.equal(after.obras.totalProjects, before.obras.totalProjects + 2, 'dashboard precisa contar as duas obras novas, somadas às já existentes');
    assert.equal(
      after.obras.committedCostTotal,
      before.obras.committedCostTotal + 1000,
      'committedCostTotal precisa ser a soma das linhas de orçamento de TODAS as obras (300 + 700), não de uma só'
    );
  });
});

test('dashboard: posObra agrega chamados de garantia de MÚLTIPLAS obras separadamente do painel de Obras', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(withTenant({ name: `Dash Obra PosObra ${Date.now()}` }), tenant.userId, transaction);
    const property = await Property.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel Dash ${Date.now()}`,
        internalCode: `DASH-${Date.now()}`,
        propertyType: 'HOUSE',
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );

    const before = await getConstructionDashboard({ groupId: tenant.groupId, companyId: tenant.companyId }, transaction);

    await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, projectId: project.id, description: 'Infiltração — dashboard', severity: 'HIGH', rootCauseCode: 'MATERIAL_DEFECT' },
      tenant.userId,
      transaction
    );

    const after = await getConstructionDashboard({ groupId: tenant.groupId, companyId: tenant.companyId }, transaction);

    assert.equal(after.posObra.totalCases, before.posObra.totalCases + 1);
    assert.equal(after.posObra.openCases, before.posObra.openCases + 1);
    // Painel de Obras não deve ser afetado pela abertura de um chamado de pós-obra (painéis
    // separados — contrato exige "dois painéis distintos", não um único contador misturado). O
    // projeto já tinha sido criado ANTES do snapshot "before", então totalProjects não muda.
    assert.equal(after.obras.totalProjects, before.obras.totalProjects, 'abrir um chamado de pós-obra não pode alterar o contador de obras do painel Obras');
    assert.ok(after.posObra.recurrenceByRootCause.some((r) => r.cause === 'MATERIAL_DEFECT'));
  });
});
