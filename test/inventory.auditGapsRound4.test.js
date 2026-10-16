'use strict';

// GAPS REAIS CORRIGIDOS (auditoria Marco 7 — Caderno Técnico Anexo I "ESTOQUE + FERRAMENTAS +
// PATRIMÔNIO — BLINDADO v1", 2026-10-08), rodada 4:
//   Gap 1 — EST-TS-08 (seção 6): NF duplicada por fingerprint só era detectada SE o chamador
//           decidisse mandar invoiceFingerprint — agora é obrigatório quando o recebimento tem
//           invoiceNumber e/ou supplierPersonId (vinculado a uma NF real).
//   Gap 2 — EST-TS-12 (seção 6): evento repetido não pode criar segunda obrigação — agora
//           idempotencyKey é obrigatório também no endpoint genérico manual pra ADJUSTMENT/
//           LOSS/DISPOSAL (os mesmos tipos que já exigem reason/aprovação).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const AppError = require('../src/utils/AppError');
const itemsService = require('../src/features/inventory/items.service');
const receiptsService = require('../src/features/inventory/receipts.service');
const movementsService = require('../src/features/inventory/movements.service');

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

async function createLocation(transaction, extra = {}) {
  return itemsService.createLocation(withTenant({ name: `GAP4 Local ${uniqueSuffix()}`, locationType: 'WAREHOUSE', ...extra }), tenant.userId, transaction);
}

async function createItem(transaction, extra = {}) {
  const suffix = uniqueSuffix();
  return itemsService.createItem(withTenant({ name: `GAP4 Item ${suffix}`, sku: `GAP4-${suffix}`, unitOfMeasure: 'UN', ...extra }), tenant.userId, transaction);
}

// ---------------------------------------------------------------------------------------------
// Gap 1 — EST-TS-08: invoiceFingerprint obrigatório quando há invoiceNumber/supplierPersonId
// ---------------------------------------------------------------------------------------------

test('Gap 1 (EST-TS-08): recebimento com invoiceNumber mas sem invoiceFingerprint é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const location = await createLocation(transaction);
    const item = await createItem(transaction);
    await assert.rejects(
      () =>
        receiptsService.createReceipt(
          withTenant({
            destinationLocationId: location.id,
            invoiceNumber: `NF-${uniqueSuffix()}`,
            items: [{ inventoryItemId: item.id, quantity: 5 }],
          }),
          tenant.userId,
          transaction
        ),
      expectCode('INVENTORY_RECEIPT_FINGERPRINT_REQUIRED')
    );
  });
});

test('Gap 1 (EST-TS-08): recebimento com supplierPersonId mas sem invoiceFingerprint é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const location = await createLocation(transaction);
    const item = await createItem(transaction);
    await assert.rejects(
      () =>
        receiptsService.createReceipt(
          withTenant({
            destinationLocationId: location.id,
            supplierPersonId: '00000000-0000-4000-8000-000000000001',
            items: [{ inventoryItemId: item.id, quantity: 5 }],
          }),
          tenant.userId,
          transaction
        ),
      expectCode('INVENTORY_RECEIPT_FINGERPRINT_REQUIRED')
    );
  });
});

test('Gap 1 (EST-TS-08): recebimento manual sem NF (sem invoiceNumber/supplierPersonId) continua aceito sem fingerprint', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const location = await createLocation(transaction);
    const item = await createItem(transaction);
    const receipt = await receiptsService.createReceipt(
      withTenant({ destinationLocationId: location.id, items: [{ inventoryItemId: item.id, quantity: 3 }] }),
      tenant.userId,
      transaction
    );
    assert.equal(receipt.status, 'DRAFT');
    assert.equal(receipt.invoiceFingerprint, null);
  });
});

test('Gap 1 (EST-TS-08): recebimento com invoiceNumber E invoiceFingerprint continua funcionando normalmente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const location = await createLocation(transaction);
    const item = await createItem(transaction);
    const fingerprint = `fp-${uniqueSuffix()}`;
    const receipt = await receiptsService.createReceipt(
      withTenant({
        destinationLocationId: location.id,
        invoiceNumber: `NF-${uniqueSuffix()}`,
        invoiceFingerprint: fingerprint,
        items: [{ inventoryItemId: item.id, quantity: 7 }],
      }),
      tenant.userId,
      transaction
    );
    assert.equal(receipt.status, 'DRAFT');
    assert.equal(receipt.invoiceFingerprint, fingerprint);

    // Duplicidade continua detectada normalmente.
    await assert.rejects(
      () =>
        receiptsService.createReceipt(
          withTenant({
            destinationLocationId: location.id,
            invoiceNumber: `NF-${uniqueSuffix()}`,
            invoiceFingerprint: fingerprint,
            items: [{ inventoryItemId: item.id, quantity: 1 }],
          }),
          tenant.userId,
          transaction
        ),
      expectCode('INVENTORY_RECEIPT_DUPLICATE_INVOICE')
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Gap 2 — EST-TS-12: idempotencyKey obrigatório para ADJUSTMENT/LOSS/DISPOSAL no endpoint manual
// ---------------------------------------------------------------------------------------------

test('Gap 2 (EST-TS-12): ADJUSTMENT sem idempotencyKey é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const location = await createLocation(transaction);
    const item = await createItem(transaction);
    await assert.rejects(
      () =>
        movementsService.recordMovement(
          withTenant({
            inventoryItemId: item.id,
            movementType: 'ADJUSTMENT',
            quantity: 2,
            destinationLocationId: location.id,
            reason: 'Ajuste manual de teste',
          }),
          approver,
          transaction
        ),
      expectCode('INVENTORY_MOVEMENT_IDEMPOTENCY_KEY_REQUIRED')
    );
  });
});

test('Gap 2 (EST-TS-12): reenviar a MESMA idempotencyKey duas vezes devolve o movimento original (sem duplicar)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const location = await createLocation(transaction);
    const item = await createItem(transaction);
    const key = `adj-test-${uniqueSuffix()}`;

    const first = await movementsService.recordMovement(
      withTenant({
        inventoryItemId: item.id,
        movementType: 'ADJUSTMENT',
        quantity: 2,
        destinationLocationId: location.id,
        reason: 'Ajuste manual de teste',
        idempotencyKey: key,
      }),
      approver,
      transaction
    );

    const second = await movementsService.recordMovement(
      withTenant({
        inventoryItemId: item.id,
        movementType: 'ADJUSTMENT',
        quantity: 2,
        destinationLocationId: location.id,
        reason: 'Ajuste manual de teste',
        idempotencyKey: key,
      }),
      approver,
      transaction
    );

    assert.equal(second.id, first.id, 'reenvio da mesma idempotencyKey deve devolver o movimento original, não criar outro');

    const balance = await movementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balance, 2, 'saldo não pode dobrar com o reenvio idempotente');
  });
});

test('Gap 2 (EST-TS-12): IN continua funcionando sem exigir idempotencyKey (fluxo interno já gera a própria)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const location = await createLocation(transaction);
    const item = await createItem(transaction);
    const movement = await movementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 4, destinationLocationId: location.id }),
      approver,
      transaction
    );
    assert.equal(movement.movementType, 'IN');
  });
});
