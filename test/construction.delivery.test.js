'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const budgetsService = require('../src/features/construction/budgets.service');
const marginRulesService = require('../src/features/construction/marginRules.service');
const nonconformitiesService = require('../src/features/construction/nonconformities.service');
const maintenanceCasesService = require('../src/features/construction/maintenanceCases.service');
const AppError = require('../src/utils/AppError');

function rejectsWithCode(expectedCode) {
  return (err) => {
    assert.ok(err instanceof AppError, `esperava AppError, recebeu ${err && err.constructor && err.constructor.name}`);
    assert.equal(err.code, expectedCode);
    return true;
  };
}

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

// M6-18: percorre a máquina de estados EXATA da fonte até o status pedido — cada etapa via o
// mecanismo real (aprovar orçamento avança PLANNED->BUDGETED automaticamente, o resto via
// transitionProject genérico).
async function createTestProject(transaction, targetStatus = 'PLANNED') {
  const project = await projectsService.createProject(withTenant({ name: `Obra de teste entrega ${uniqueSuffix()}` }), tenant.userId, transaction);
  if (targetStatus === 'PLANNED') return project;

  await marginRulesService.createMarginRule(withTenant({ minMarginPct: 10 }), tenant.userId, transaction);
  const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
  await budgetsService.approveBudget(budget.id, tenant.userId, transaction); // PLANNED -> BUDGETED
  if (targetStatus === 'BUDGETED') return projectsService.getProject(project.id, transaction);

  await projectsService.transitionProject(project.id, 'READY', tenant.userId, transaction);
  if (targetStatus === 'READY') return projectsService.getProject(project.id, transaction);

  await projectsService.transitionProject(project.id, 'ACTIVE', tenant.userId, transaction);
  if (targetStatus === 'ACTIVE') return projectsService.getProject(project.id, transaction);

  await projectsService.transitionProject(project.id, 'FINAL_INSPECTION', tenant.userId, transaction);
  return projectsService.getProject(project.id, transaction);
}

// --- Máquina de estados: DELIVERED é um estado válido, mas não alcançável pela transição genérica ---

test('delivery: STATUSES inclui os 8 estados exatos da fonte + CANCELLED', () => {
  for (const status of ['PLANNED', 'BUDGETED', 'READY', 'ACTIVE', 'PAUSED', 'FINAL_INSPECTION', 'DELIVERED', 'WARRANTY', 'CLOSED', 'CANCELLED']) {
    assert.ok(projectsService.STATUSES.includes(status), `falta o status ${status}`);
  }
});

test('delivery: transitionProject genérico não permite ir direto para DELIVERED (só via gate dedicado)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');
    await assert.rejects(
      () => projectsService.transitionProject(project.id, 'DELIVERED', tenant.userId, transaction),
      rejectsWithCode('PROJECT_STATUS_TRANSITION_INVALID')
    );
  });
});

test('delivery: máquina de estados completa PLANNED->BUDGETED->READY->ACTIVE->PAUSED->ACTIVE->FINAL_INSPECTION funciona de ponta a ponta', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'ACTIVE');
    assert.equal(project.status, 'ACTIVE');

    const paused = await projectsService.transitionProject(project.id, 'PAUSED', tenant.userId, transaction);
    assert.equal(paused.status, 'PAUSED');

    const resumed = await projectsService.transitionProject(project.id, 'ACTIVE', tenant.userId, transaction);
    assert.equal(resumed.status, 'ACTIVE');

    const finalInspection = await projectsService.transitionProject(project.id, 'FINAL_INSPECTION', tenant.userId, transaction);
    assert.equal(finalInspection.status, 'FINAL_INSPECTION');
    assert.ok(finalInspection.actualEndDate, 'actualEndDate deve ser preenchido automaticamente ao entrar em FINAL_INSPECTION');
  });
});

// --- Gate de entrega (M6-25/M6-39/M6-51/M6-65/M6-79/M6-87) ---

test('delivery: deliverProject recusa entregar obra que não está FINAL_INSPECTION', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'ACTIVE');
    await assert.rejects(
      () => projectsService.deliverProject(project.id, tenant.userId, transaction),
      rejectsWithCode('PROJECT_NOT_READY_FOR_DELIVERY')
    );
  });
});

test('delivery: deliverProject entrega obra FINAL_INSPECTION sem pendência crítica e avança direto para WARRANTY', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');
    const delivered = await projectsService.deliverProject(project.id, tenant.userId, transaction);
    // M6-18: DELIVERED é instantâneo — a mesma chamada já avança para WARRANTY.
    assert.equal(delivered.status, 'WARRANTY');
  });
});

// M6-65: entregar com pendência crítica bloqueia — teste de integração real contra a tabela
// `construction.nonconformities` (já mergeada), sem stub.
test('delivery: deliverProject BLOQUEIA entrega quando há não conformidade CRITICAL/OPEN vinculada ao projeto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');
    await nonconformitiesService.createNonconformity(
      project.id,
      withTenant({ description: 'Rachadura estrutural', severity: 'CRITICAL' }),
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => projectsService.deliverProject(project.id, tenant.userId, transaction),
      rejectsWithCode('PROJECT_DELIVERY_BLOCKED_BY_CRITICAL_NONCONFORMITY')
    );

    const reloaded = await projectsService.getProject(project.id, transaction);
    assert.equal(reloaded.status, 'FINAL_INSPECTION', 'projeto não deveria ter sido transicionado quando bloqueado');
  });
});

test('delivery: hasOpenCriticalNonconformity retorna false quando não há nenhuma NC crítica aberta', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');
    const blocked = await projectsService.hasOpenCriticalNonconformity(tenant.companyId, project.id, transaction);
    assert.equal(blocked, false);
  });
});

// --- M6-18: fechamento definitivo (WARRANTY -> CLOSED) ---

test('closeProjectWarranty: bloqueia fechar com caso de garantia ainda aberto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');
    const delivered = await projectsService.deliverProject(project.id, tenant.userId, transaction);
    assert.equal(delivered.status, 'WARRANTY');

    const [[property]] = await sequelize.query('SELECT id FROM real_estate.properties LIMIT 1', { transaction });
    await maintenanceCasesService.createMaintenanceCase(
      withTenant({ propertyId: property.id, projectId: project.id, description: 'Infiltração', severity: 'MEDIUM' }),
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => projectsService.closeProjectWarranty(project.id, tenant.userId, transaction),
      rejectsWithCode('PROJECT_WARRANTY_CLOSE_BLOCKED_BY_OPEN_CASE')
    );
  });
});

test('closeProjectWarranty: fecha a obra quando todos os casos de garantia estão CLOSED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');
    await projectsService.deliverProject(project.id, tenant.userId, transaction);

    const [[property]] = await sequelize.query('SELECT id FROM real_estate.properties LIMIT 1', { transaction });
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      withTenant({ propertyId: property.id, projectId: project.id, description: 'Infiltração', severity: 'MEDIUM' }),
      tenant.userId,
      transaction
    );
    await maintenanceCasesService.updateMaintenanceCase(warrantyCase.id, { status: 'CLOSED' }, tenant.userId, transaction);

    const closed = await projectsService.closeProjectWarranty(project.id, tenant.userId, transaction);
    assert.equal(closed.status, 'CLOSED');
  });
});

test('closeProjectWarranty: recusa fechar obra que não está WARRANTY', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'ACTIVE');
    await assert.rejects(
      () => projectsService.closeProjectWarranty(project.id, tenant.userId, transaction),
      rejectsWithCode('PROJECT_NOT_IN_WARRANTY')
    );
  });
});
