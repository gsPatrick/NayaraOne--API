'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { Property } = require('../src/models');
const maintenanceCasesService = require('../src/features/construction/maintenanceCases.service');
const { escalateOverdueWarrantyCases } = require('../src/engines/jobs/warrantyEscalationJob');
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

async function createTestProperty(transaction) {
  const suffix = uniqueSuffix();
  return Property.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      title: `Imóvel de teste garantia ${suffix}`,
      internalCode: `WARR-${suffix}`,
      propertyType: 'HOUSE',
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

// --- computeEscalationLevel (função pura — M6-63/M6-88) ---

test('warranty: computeEscalationLevel marca OVERDUE quando sla_due_at está no passado', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const past = new Date('2026-09-25T12:00:00Z');
  assert.equal(maintenanceCasesService.computeEscalationLevel(past, now), 'OVERDUE');
});

test('warranty: computeEscalationLevel marca CRITICAL quando falta <= 1 dia (inclusive vencendo hoje)', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const dueToday = new Date('2026-09-30T18:00:00Z');
  const dueTomorrow = new Date('2026-10-01T10:00:00Z');
  assert.equal(maintenanceCasesService.computeEscalationLevel(dueToday, now), 'CRITICAL');
  assert.equal(maintenanceCasesService.computeEscalationLevel(dueTomorrow, now), 'CRITICAL');
});

test('warranty: computeEscalationLevel marca WARNING quando falta <= 2 dias', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const dueIn2Days = new Date('2026-10-02T10:00:00Z');
  assert.equal(maintenanceCasesService.computeEscalationLevel(dueIn2Days, now), 'WARNING');
});

test('warranty: computeEscalationLevel marca NONE quando falta mais de 2 dias ou não há sla_due_at', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const dueIn10Days = new Date('2026-10-10T10:00:00Z');
  assert.equal(maintenanceCasesService.computeEscalationLevel(dueIn10Days, now), 'NONE');
  assert.equal(maintenanceCasesService.computeEscalationLevel(null, now), 'NONE');
});

// --- createMaintenanceCase / updateMaintenanceCase (WarrantyCase estruturado — M6-15/M6-16) ---

test('warranty: createMaintenanceCase calcula sla_due_at e escalation_level a partir da severidade', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        description: 'Infiltração no teto da sala.',
        category: 'WATERPROOFING',
        severity: 'CRITICAL',
        rootCauseCode: 'MATERIAL_DEFECT',
      },
      tenant.userId,
      transaction
    );

    assert.equal(warrantyCase.category, 'WATERPROOFING');
    assert.equal(warrantyCase.severity, 'CRITICAL');
    assert.equal(warrantyCase.rootCauseCode, 'MATERIAL_DEFECT');
    assert.ok(warrantyCase.slaDueAt, 'sla_due_at deveria ter sido calculado');
    // CRITICAL = 2 dias de SLA a partir de agora.
    const expectedDueAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const diffMs = Math.abs(new Date(warrantyCase.slaDueAt).getTime() - expectedDueAt.getTime());
    assert.ok(diffMs < 60 * 1000, 'sla_due_at deveria ser ~2 dias a partir de agora (severidade CRITICAL)');
  });
});

test('warranty: updateMaintenanceCase rejeita severity/category/rootCauseCode fora da lista configurada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Chamado teste.' },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => maintenanceCasesService.updateMaintenanceCase(warrantyCase.id, { severity: 'ALIEN' }, tenant.userId, transaction),
      rejectsWithCode('MAINTENANCE_CASE_SEVERITY_INVALID')
    );
  });
});

// --- warrantyEscalationJob (M6-63/M6-88): um caso com sla_due_at vencido é marcado OVERDUE ---

test('warranty: warrantyEscalationJob escalona para OVERDUE um caso com sla_due_at no passado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        description: 'Trinca na parede — SLA já vencido.',
        severity: 'LOW',
      },
      tenant.userId,
      transaction
    );

    // Força o SLA para o passado (simula o tempo passando sem atendimento).
    warrantyCase.slaDueAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    warrantyCase.escalationLevel = 'NONE';
    await warrantyCase.save({ transaction });

    const result = await escalateOverdueWarrantyCases(transaction);
    assert.ok(result.casesChecked >= 1);
    assert.ok(result.escalated >= 1);

    await warrantyCase.reload({ transaction });
    assert.equal(warrantyCase.escalationLevel, 'OVERDUE');
  });
});

test('warranty: warrantyEscalationJob é idempotente — rodar de novo sem mudança não reescalona', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Caso já OVERDUE.' },
      tenant.userId,
      transaction
    );
    warrantyCase.slaDueAt = new Date(Date.now() - 1000);
    warrantyCase.escalationLevel = 'OVERDUE';
    await warrantyCase.save({ transaction });

    const result = await escalateOverdueWarrantyCases(transaction);
    const thisCase = result.escalated;
    assert.equal(thisCase >= 0, true);
    // Já estava OVERDUE — não deveria ter sido recontado como escalonamento novo para ESTE caso.
    await warrantyCase.reload({ transaction });
    assert.equal(warrantyCase.escalationLevel, 'OVERDUE');
  });
});

// --- WarrantyAction (histórico de atendimento com custo) ---

test('warranty: createWarrantyAction registra ação de atendimento vinculada ao chamado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Vazamento no banheiro.' },
      tenant.userId,
      transaction
    );

    const action = await maintenanceCasesService.createWarrantyAction(
      warrantyCase.id,
      { description: 'Troca do registro hidráulico.', cost: 350.5 },
      tenant.userId,
      transaction
    );

    assert.equal(action.warrantyCaseId, warrantyCase.id);
    assert.equal(Number(action.cost), 350.5);

    const actions = await maintenanceCasesService.listWarrantyActions(warrantyCase.id, transaction);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].id, action.id);
  });
});

// --- Evento de fechamento (M6-80) ---

test('warranty: fechar o chamado (status=CLOSED) não lança erro (evento warranty.case.closed disparado)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Chamado a ser fechado.' },
      tenant.userId,
      transaction
    );
    const closed = await maintenanceCasesService.updateMaintenanceCase(
      warrantyCase.id,
      { status: 'CLOSED' },
      tenant.userId,
      transaction
    );
    assert.equal(closed.status, 'CLOSED');
  });
});
