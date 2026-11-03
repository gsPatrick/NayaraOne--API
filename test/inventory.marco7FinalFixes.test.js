'use strict';

// GAP REAL CORRIGIDO (auditoria final Nayara, Marco 7, 15/10/2026):
// 1. Requisição de material aceitava uma "obra" divergente da obra real já vinculada ao canteiro
//    de destino — o movimento acabava gravando a obra errada. Agora a obra do canteiro é a fonte
//    de verdade, sempre sobrescrevendo qualquer projectId divergente enviado.
// 2. Quem cria a requisição/perda podia aprovar/rejeitar o próprio caso — terceira rodada de
//    auditoria independente apontando essa inconsistência (já bloqueada em Compras e Ajuste de
//    inventário). Agora bloqueado também em requisição de material e em perda.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const requisitionsService = require('../src/features/inventory/requisitions.service');
const movementsService = require('../src/features/inventory/movements.service');
const lossCasesService = require('../src/features/inventory/lossCases.service');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const { User, File } = require('../src/models');
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

async function createSecondUser(suffix) {
  const [user] = await User.findOrCreate({
    where: { email: `homo-qa-m7final-${suffix}@nayaraone.dev` },
    defaults: { name: `HOMO QA — M7final ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
  });
  return user.id;
}

async function createItemAndWarehouse(transaction, suffix) {
  const item = await itemsService.createItem(
    withTenant({ name: `M7FINAL Item ${suffix}`, sku: `M7FINAL-${suffix}`, unitOfMeasure: 'UN' }),
    tenant.userId,
    transaction
  );
  const warehouse = await itemsService.createLocation(
    withTenant({ name: `M7FINAL Almoxarifado ${suffix}`, locationType: 'WAREHOUSE' }),
    tenant.userId,
    transaction
  );
  return { item, warehouse };
}

test('M7FINAL-01: requisição pra canteiro de obra X ignora obra Y divergente e usa a obra real do canteiro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const { item, warehouse } = await createItemAndWarehouse(transaction, suffix);

    const realProject = await projectsService.createProject(withTenant({ name: `M7FINAL Obra Real ${suffix}` }), tenant.userId, transaction);
    const wrongProject = await projectsService.createProject(withTenant({ name: `M7FINAL Obra Errada ${suffix}` }), tenant.userId, transaction);

    const siteLocation = await itemsService.createLocation(
      withTenant({ name: `M7FINAL Canteiro ${suffix}`, locationType: 'PROJECT_SITE', projectId: realProject.id }),
      tenant.userId,
      transaction
    );

    const realStage = await projectStagesService.createProjectStage(realProject.id, withTenant({ name: 'Etapa' }), tenant.userId, transaction);
    // Front/cliente malicioso ou desatualizado manda a obra ERRADA junto com o canteiro certo.
    const requisition = await requisitionsService.createRequisition(
      withTenant({
        warehouseLocationId: warehouse.id,
        projectLocationId: siteLocation.id,
        projectId: wrongProject.id,
        stageId: realStage.id,
        items: [{ inventoryItemId: item.id, quantity: 5 }],
      }),
      tenant.userId,
      transaction
    );

    assert.equal(requisition.projectId, realProject.id, 'a obra gravada deve ser a obra REAL do canteiro, nunca a divergente enviada pelo cliente');
    assert.notEqual(requisition.projectId, wrongProject.id);
  });
});

test('M7FINAL-02: requisição pra canteiro legado (sem obra no cadastro) ainda exige projectId explícito', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const { item, warehouse } = await createItemAndWarehouse(transaction, suffix);

    // Simula um canteiro antigo, criado antes da correção F2, sem projectId no cadastro —
    // precisa inserir direto pra contornar a validação de criação (que já exige obra hoje).
    const { InventoryLocation } = require('../src/models');
    const legacySite = await InventoryLocation.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `M7FINAL Canteiro Legado ${suffix}`, locationType: 'PROJECT_SITE', projectId: null, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );

    await assert.rejects(
      () =>
        requisitionsService.createRequisition(
          withTenant({ warehouseLocationId: warehouse.id, projectLocationId: legacySite.id, items: [{ inventoryItemId: item.id, quantity: 5 }] }),
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'REQUISITION_PROJECT_LOCATION_REQUIRES_PROJECT');
        return true;
      }
    );
  });
});

test('M7FINAL-03: quem cria a requisição de material não pode aprová-la/rejeitá-la', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const { item, warehouse } = await createItemAndWarehouse(transaction, suffix);

    const requisition = await requisitionsService.createRequisition(
      withTenant({ warehouseLocationId: warehouse.id, items: [{ inventoryItemId: item.id, quantity: 5 }] }),
      tenant.userId,
      transaction
    );
    assert.equal(requisition.requestedByUserId, tenant.userId);

    await assert.rejects(
      () => requisitionsService.decideRequisition(requisition.id, 'APPROVED', tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INVENTORY_REQUISITION_SELF_APPROVAL_BLOCKED');
        return true;
      }
    );

    const otherUserId = await createSecondUser(suffix);
    const decided = await requisitionsService.decideRequisition(requisition.id, 'APPROVED', otherUserId, tenant.groupId, tenant.companyId, transaction);
    assert.equal(decided.status, 'APPROVED', 'uma pessoa diferente de quem solicitou deve conseguir decidir normalmente');
  });
});

test('M7FINAL-04: quem registra a perda não pode aprová-la/rejeitá-la', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const { item, warehouse } = await createItemAndWarehouse(transaction, suffix);
    await movementsService.recordMovement(
      { groupId: tenant.groupId, companyId: tenant.companyId, inventoryItemId: item.id, movementType: 'IN', quantity: 10, destinationLocationId: warehouse.id },
      { userId: tenant.userId, canApprove: true },
      transaction
    );

    const file = await File.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, fileName: 'evidencia.jpg', storageKey: `m7final/${suffix}.jpg`, mimeType: 'image/jpeg', sizeBytes: 100, uploadedBy: tenant.userId },
      { transaction }
    );

    const lossCase = await lossCasesService.openLossCase(
      withTenant({ inventoryItemId: item.id, locationId: warehouse.id, quantity: 1, evidenceFileIds: [file.id], context: 'AUDIT M7FINAL — teste de autoaprovação' }),
      tenant.userId,
      transaction
    );
    assert.equal(lossCase.createdBy, tenant.userId);

    await assert.rejects(
      () =>
        lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', { userId: tenant.userId, canApprove: true }, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LOSS_CASE_SELF_APPROVAL_BLOCKED');
        return true;
      }
    );

    const otherUserId = await createSecondUser(`${suffix}-b`);
    const decided = await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', { userId: otherUserId, canApprove: true }, transaction);
    assert.equal(decided.status, 'APPROVED', 'uma pessoa diferente de quem registrou deve conseguir decidir normalmente');
  });
});
