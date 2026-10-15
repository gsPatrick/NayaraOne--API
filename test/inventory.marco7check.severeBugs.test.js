'use strict';

// BUGS GRAVES REAIS CORRIGIDOS (auditoria "check" do Marco 7, 15/10/2026):
// 1. Um "Ajuste" (ADJUSTMENT) com sourceLocationId E destinationLocationId preenchidos ao mesmo
//    tempo passava pela validação (nenhum dos dois estava vazio) e caía no ramo que só credita o
//    destino — a origem nunca era debitada, criando saldo do nada. Agora bloqueado explicitamente:
//    ajuste corrige um local por vez, mover entre dois locais é Transferência.
// 2. A mesma nota fiscal (mesmo invoiceNumber) podia ser confirmada duas vezes se o campo livre
//    "identificador único" (invoiceFingerprint, digitado pelo usuário) viesse com um valor
//    diferente na segunda vez. Agora o número da nota fiscal também é checado como chave de
//    duplicidade, independente do fingerprint.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const receiptsService = require('../src/features/inventory/receipts.service');
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

function actorOf(extra) {
  return { userId: tenant.userId, ...extra };
}

async function createItemAndTwoWarehouses(transaction, suffix) {
  const item = await itemsService.createItem(
    withTenant({ name: `M7CHECK Item ${suffix}`, sku: `M7CHECK-${suffix}`, unitOfMeasure: 'UN' }),
    tenant.userId,
    transaction
  );
  const warehouseA = await itemsService.createLocation(
    withTenant({ name: `M7CHECK Almoxarifado A ${suffix}`, locationType: 'WAREHOUSE' }),
    tenant.userId,
    transaction
  );
  const warehouseB = await itemsService.createLocation(
    withTenant({ name: `M7CHECK Almoxarifado B ${suffix}`, locationType: 'WAREHOUSE' }),
    tenant.userId,
    transaction
  );
  return { item, warehouseA, warehouseB };
}

test('M7CHECK-01: Ajuste com origem E destino preenchidos é rejeitado (não cria saldo do nada)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const { item, warehouseA, warehouseB } = await createItemAndTwoWarehouses(transaction, suffix);

    // Entrada inicial de 10 em A, pra ter saldo de referência.
    await movementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 10, destinationLocationId: warehouseA.id, sourceType: 'MANUAL' }),
      actorOf({ canApprove: true }),
      transaction
    );

    await assert.rejects(
      () =>
        movementsService.recordMovement(
          withTenant({
            inventoryItemId: item.id,
            movementType: 'ADJUSTMENT',
            quantity: 2,
            sourceLocationId: warehouseA.id,
            destinationLocationId: warehouseB.id,
            sourceType: 'MANUAL',
            reason: 'Tentativa de ajuste com origem e destino (deve ser rejeitado).',
          }),
          actorOf({ canApprove: true }),
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INVENTORY_MOVEMENT_VALIDATION');
        return true;
      }
    );

    const balanceA = await movementsService.getBalance(item.id, warehouseA.id, tenant.groupId, tenant.companyId, transaction);
    const balanceB = await movementsService.getBalance(item.id, warehouseB.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balanceA, 10, 'saldo de origem não pode ter sido alterado por um ajuste rejeitado');
    assert.equal(balanceB, 0, 'saldo de destino não pode ter sido criado do nada');
  });
});

test('M7CHECK-01b: Ajuste só com destino (aumentar) continua funcionando normalmente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const { item, warehouseA } = await createItemAndTwoWarehouses(transaction, suffix);

    await movementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'ADJUSTMENT', quantity: 5, destinationLocationId: warehouseA.id, sourceType: 'MANUAL', reason: 'Ajuste de conferência (só destino).', idempotencyKey: `m7check-adj-dest-${suffix}` }),
      actorOf({ canApprove: true }),
      transaction
    );

    const balance = await movementsService.getBalance(item.id, warehouseA.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balance, 5);
  });
});

test('M7CHECK-01c: Ajuste só com origem (diminuir) continua funcionando normalmente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const { item, warehouseA } = await createItemAndTwoWarehouses(transaction, suffix);

    await movementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 10, destinationLocationId: warehouseA.id, sourceType: 'MANUAL' }),
      actorOf({ canApprove: true }),
      transaction
    );
    await movementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'ADJUSTMENT', quantity: 3, sourceLocationId: warehouseA.id, sourceType: 'MANUAL', reason: 'Ajuste de conferência (só origem).', idempotencyKey: `m7check-adj-src-${suffix}` }),
      actorOf({ canApprove: true }),
      transaction
    );

    const balance = await movementsService.getBalance(item.id, warehouseA.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balance, 7);
  });
});

test('M7CHECK-02: nota fiscal com o mesmo número não pode ser confirmada duas vezes, mesmo com "identificador único" diferente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const { item, warehouseA } = await createItemAndTwoWarehouses(transaction, suffix);
    const invoiceNumber = `M7CHECK-NF-${suffix}`;

    const receipt1 = await receiptsService.createReceipt(
      withTenant({
        destinationLocationId: warehouseA.id,
        invoiceNumber,
        invoiceFingerprint: `fingerprint-a-${suffix}`,
        items: [{ inventoryItemId: item.id, quantity: 10, unitCost: 5 }],
      }),
      tenant.userId,
      transaction
    );
    await receiptsService.reviewReceipt(receipt1.id, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await receiptsService.confirmReceipt(receipt1.id, actorOf(), tenant.groupId, tenant.companyId, transaction);

    // Mesmo número de NF, "identificador único" DIFERENTE da primeira vez — deve ser bloqueado
    // mesmo assim, porque o número da nota é a chave de negócio real.
    await assert.rejects(
      () =>
        receiptsService.createReceipt(
          withTenant({
            destinationLocationId: warehouseA.id,
            invoiceNumber,
            invoiceFingerprint: `fingerprint-b-${suffix}`,
            items: [{ inventoryItemId: item.id, quantity: 10, unitCost: 5 }],
          }),
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INVENTORY_RECEIPT_DUPLICATE_INVOICE');
        return true;
      }
    );
  });
});
