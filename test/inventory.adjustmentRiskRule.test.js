'use strict';

// GAP REAL CORRIGIDO (reauditoria externa Nayara, 3ª rodada, 2026-10-08; EST-008: "ajuste de
// estoque exige motivo, evidência e aprovação conforme valor/risco"): motivo e aprovação já
// eram sempre obrigatórios para ADJUSTMENT/LOSS/DISPOSAL, mas "conforme valor/risco" não tinha
// tradução em código — evidência era sempre opcional, mesmo para ajustes de altíssimo valor.
// Estes testes provam o limiar REG-EST-002 (Motor de Regras genérico, mesmo padrão de
// REG-OBR-001/REG-OBR-002/REG-EST-001): abaixo do limiar evidência continua opcional, no/acima
// do limiar passa a ser obrigatória, e o fluxo de ajuste de contagem (counts.service.js) sabe
// propagar evidenceFileId para o movimento gerado.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const receiptsService = require('../src/features/inventory/receipts.service');
const movementsService = require('../src/features/inventory/movements.service');
const countsService = require('../src/features/inventory/counts.service');
const adjustmentRiskRules = require('../src/features/inventory/adjustmentRiskRules.service');
const { File } = require('../src/models');
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

const actor = () => ({ userId: tenant.userId, canApprove: true });

async function createItemAndWarehouse(transaction) {
  const suffix = uniqueSuffix();
  const item = await itemsService.createItem(
    withTenant({ name: `EST008 Item ${suffix}`, sku: `EST008-${suffix}`, unitOfMeasure: 'UN' }),
    tenant.userId,
    transaction
  );
  const location = await itemsService.createLocation(
    withTenant({ name: `EST008 Depósito ${suffix}` , locationType: 'WAREHOUSE' }),
    tenant.userId,
    transaction
  );
  return { item, location };
}

async function receive(transaction, item, location, quantity, unitCost) {
  const receipt = await receiptsService.createReceipt(
    withTenant({ destinationLocationId: location.id, items: [{ inventoryItemId: item.id, quantity, unitCost }] }),
    tenant.userId,
    transaction
  );
  await receiptsService.reviewReceipt(receipt.id, tenant.userId, transaction);
  await receiptsService.confirmReceipt(receipt.id, { userId: tenant.userId, canApprove: true }, transaction);
}

async function createFile(transaction) {
  return File.create(
    withTenant({
      fileName: `evidencia-${uniqueSuffix()}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      storageKey: `test/${uniqueSuffix()}.jpg`,
      uploadedBy: tenant.userId,
    }),
    { transaction }
  );
}

test('REG-EST-002: ajuste de baixo valor não exige evidenceFileId', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    await receive(transaction, item, location, 100, 1); // averageCost = 1 -> 5 un = R$5, bem abaixo do limiar padrão R$1000

    const movement = await movementsService.recordMovement(
      withTenant({
        inventoryItemId: item.id,
        movementType: 'ADJUSTMENT',
        quantity: 5,
        sourceLocationId: location.id,
        reason: 'Ajuste de baixo valor de teste.',
      }),
      actor(),
      transaction
    );
    assert.ok(movement.id);
  });
});

test('REG-EST-002: ajuste de alto valor sem evidenceFileId é bloqueado com INVENTORY_MOVEMENT_EVIDENCE_REQUIRED_HIGH_VALUE', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    await receive(transaction, item, location, 100, 50); // averageCost = 50 -> 30 un = R$1500, acima do limiar padrão R$1000

    await assert.rejects(
      () => movementsService.recordMovement(
        withTenant({
          inventoryItemId: item.id,
          movementType: 'ADJUSTMENT',
          quantity: 30,
          sourceLocationId: location.id,
          reason: 'Ajuste de alto valor de teste, sem evidência.',
        }),
        actor(),
        transaction
      ),
      (err) => err instanceof AppError && err.code === 'INVENTORY_MOVEMENT_EVIDENCE_REQUIRED_HIGH_VALUE'
    );
  });
});

test('REG-EST-002: ajuste de alto valor COM evidenceFileId passa normalmente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    await receive(transaction, item, location, 100, 50);
    const file = await createFile(transaction);

    const movement = await movementsService.recordMovement(
      withTenant({
        inventoryItemId: item.id,
        movementType: 'ADJUSTMENT',
        quantity: 30,
        sourceLocationId: location.id,
        reason: 'Ajuste de alto valor de teste, com evidência.',
        evidenceFileId: file.id,
      }),
      actor(),
      transaction
    );
    assert.ok(movement.id);
    assert.equal(movement.evidenceFileId, file.id);
  });
});

test('REG-EST-002: limiar é configurável via Motor de Regras (nova versão fecha a anterior, imutável)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    await receive(transaction, item, location, 100, 50); // averageCost 50 -> 10 un = R$500

    // Limiar padrão R$1000: R$500 passa sem evidência.
    const low = await movementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'ADJUSTMENT', quantity: 10, sourceLocationId: location.id, reason: 'Abaixo do limiar padrão.' }),
      actor(),
      transaction
    );
    assert.ok(low.id);

    // Abaixa o limiar para R$100 — agora R$500 (ou qualquer ajuste >= R$100) passa a exigir evidência.
    await adjustmentRiskRules.createAdjustmentRiskRule(withTenant({ highValueThreshold: 100 }), tenant.userId, transaction);

    await assert.rejects(
      () => movementsService.recordMovement(
        withTenant({ inventoryItemId: item.id, movementType: 'ADJUSTMENT', quantity: 10, sourceLocationId: location.id, reason: 'Acima do novo limiar.' }),
        actor(),
        transaction
      ),
      (err) => err instanceof AppError && err.code === 'INVENTORY_MOVEMENT_EVIDENCE_REQUIRED_HIGH_VALUE'
    );
  });
});

test('REG-EST-002: ajuste de contagem (counts.service.js#applyAdjustment) de alto valor propaga evidenceFileId', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    await receive(transaction, item, location, 100, 80); // averageCost 80

    const count = await countsService.openCount(withTenant({ locationId: location.id }), tenant.userId, transaction);
    // saldo esperado 100, contado 80 -> divergência -20, valor estimado 20*80=R$1600 (> limiar)
    await countsService.addCountItem(count.id, { inventoryItemId: item.id, countedQuantity: 80 }, transaction);
    const completed = await countsService.completeCount(count.id, tenant.userId, transaction);
    const line = completed.items.find((l) => l.inventoryItemId === item.id);

    await assert.rejects(
      () => countsService.applyAdjustment(line.id, actor(), transaction),
      (err) => err instanceof AppError && err.code === 'INVENTORY_MOVEMENT_EVIDENCE_REQUIRED_HIGH_VALUE'
    );

    const file = await createFile(transaction);
    const adjusted = await countsService.applyAdjustment(line.id, actor(), transaction, file.id);
    assert.ok(adjusted.adjustmentMovementId, 'ajuste aplicado com sucesso ao informar evidenceFileId');
  });
});
