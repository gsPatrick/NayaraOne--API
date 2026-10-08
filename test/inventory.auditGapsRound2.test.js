'use strict';

// GAPS REAIS CORRIGIDOS (auditoria de conformidade, rodada 2, 2026-10-08):
//   Gap 1 — EST-004 (direção inversa): requisição com projectLocationId apontando pra um
//           InventoryLocation PROJECT_SITE, sem projectId/stageId informados, era aceita sem
//           vínculo de obra — o OUT gerado depois em issueRequisition saía com projectId: null.
//   Gap 2 — EST-010: movementType "LOSS" podia ser registrado direto pelo endpoint genérico de
//           movimentos, sem NENHUM vínculo com um InventoryLossCase aprovado — pulando a
//           investigação/decisão humana obrigatória.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const requisitionsService = require('../src/features/inventory/requisitions.service');
const lossCasesService = require('../src/features/inventory/lossCases.service');
const filesService = require('../src/features/files/files.service');
const projectsService = require('../src/features/construction/projects.service');
const AppError = require('../src/utils/AppError');

let tenant;
let approver;

before(async () => {
  tenant = await getSeedTenant();
  approver = { userId: tenant.userId, canApprove: true };
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

function expectCode(code) {
  return (err) => {
    assert.ok(err instanceof AppError, `esperava AppError ${code}, veio: ${err?.message}`);
    assert.equal(err.code, code);
    return true;
  };
}

async function createLocation(transaction, locationType = 'WAREHOUSE', extra = {}) {
  return itemsService.createLocation(withTenant({ name: `GAP R2 Local ${uniqueSuffix()}`, locationType, ...extra }), tenant.userId, transaction);
}

async function createItem(transaction, extra = {}) {
  const suffix = uniqueSuffix();
  return itemsService.createItem(withTenant({ name: `GAP R2 Item ${suffix}`, sku: `GAPR2-${suffix}`, unitOfMeasure: 'UN', ...extra }), tenant.userId, transaction);
}

async function createEvidence(transaction) {
  return filesService.uploadFile(
    withTenant({ fileName: 'evidencia-perda.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('EVIDENCIA').toString('base64'), category: 'generic' }),
    tenant.userId,
    transaction
  );
}

// ---------------------------------------------------------------------------------------------
// Gap 1 — EST-004 (direção inversa): projectLocationId PROJECT_SITE sem projectId
// ---------------------------------------------------------------------------------------------

test('Gap 1 (EST-004): requisição recusa projectLocationId de PROJECT_SITE sem projectId', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(withTenant({ name: `Obra GAP R2 ${uniqueSuffix()}` }), tenant.userId, transaction);
    const warehouse = await createLocation(transaction);
    const site = await createLocation(transaction, 'PROJECT_SITE', { projectId: project.id });
    const item = await createItem(transaction);

    await assert.rejects(
      () => requisitionsService.createRequisition(
        withTenant({ warehouseLocationId: warehouse.id, projectLocationId: site.id, items: [{ inventoryItemId: item.id, quantity: 1 }] }),
        tenant.userId,
        transaction
      ),
      expectCode('REQUISITION_PROJECT_LOCATION_REQUIRES_PROJECT')
    );
  });
});

test('Gap 1 (EST-004): requisição aceita projectLocationId de PROJECT_SITE quando projectId é informado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(withTenant({ name: `Obra GAP R2 ${uniqueSuffix()}` }), tenant.userId, transaction);
    const warehouse = await createLocation(transaction);
    const site = await createLocation(transaction, 'PROJECT_SITE', { projectId: project.id });
    const item = await createItem(transaction);

    const requisition = await requisitionsService.createRequisition(
      withTenant({ warehouseLocationId: warehouse.id, projectLocationId: site.id, projectId: project.id, items: [{ inventoryItemId: item.id, quantity: 1 }] }),
      tenant.userId,
      transaction
    );
    assert.equal(requisition.projectId, project.id);
    assert.equal(requisition.projectLocationId, site.id);
  });
});

// ---------------------------------------------------------------------------------------------
// Gap 2 — EST-010: LOSS direto sem InventoryLossCase aprovado
// ---------------------------------------------------------------------------------------------

test('Gap 2 (EST-010): movimento LOSS direto (sem loss case) é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const warehouse = await createLocation(transaction);
    const item = await createItem(transaction);
    const evidence = await createEvidence(transaction);

    await assert.rejects(
      () => movementsService.recordMovement(
        withTenant({
          inventoryItemId: item.id,
          movementType: 'LOSS',
          quantity: 1,
          sourceLocationId: warehouse.id,
          reason: 'Perda sem caso',
          evidenceFileId: evidence.id,
        }),
        approver,
        transaction
      ),
      expectCode('INVENTORY_MOVEMENT_LOSS_REQUIRES_LOSS_CASE')
    );
  });
});

test('Gap 2 (EST-010): movimento LOSS é recusado se o loss case referenciado não está APPROVED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const warehouse = await createLocation(transaction);
    const item = await createItem(transaction);
    const evidence = await createEvidence(transaction);

    const lossCase = await lossCasesService.openLossCase(
      withTenant({
        inventoryItemId: item.id,
        locationId: warehouse.id,
        quantity: 1,
        context: 'Quebra em transporte',
        evidenceFileIds: [evidence.id],
      }),
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => movementsService.recordMovement(
        withTenant({
          inventoryItemId: item.id,
          movementType: 'LOSS',
          quantity: 1,
          sourceLocationId: warehouse.id,
          sourceType: 'LOSS_CASE',
          sourceId: lossCase.id,
          reason: 'Perda com caso ainda OPEN',
          evidenceFileId: evidence.id,
        }),
        approver,
        transaction
      ),
      expectCode('INVENTORY_MOVEMENT_LOSS_REQUIRES_LOSS_CASE')
    );
  });
});

test('Gap 2 (EST-010): decideLossCase (APPROVED) gera o movimento LOSS vinculado corretamente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const warehouse = await createLocation(transaction);
    const item = await createItem(transaction);
    const evidence = await createEvidence(transaction);

    // Dá saldo ao item no local antes da perda (LOSS debita saldo real — precisa existir).
    await movementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 5, destinationLocationId: warehouse.id }),
      approver,
      transaction
    );

    const lossCase = await lossCasesService.openLossCase(
      withTenant({
        inventoryItemId: item.id,
        locationId: warehouse.id,
        quantity: 1,
        context: 'Quebra em transporte',
        evidenceFileIds: [evidence.id],
      }),
      tenant.userId,
      transaction
    );

    const decided = await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', approver, transaction, {});
    assert.equal(decided.status, 'APPROVED');
    assert.ok(decided.resultingMovementId);
  });
});
