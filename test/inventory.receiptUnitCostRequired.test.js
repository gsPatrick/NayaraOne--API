'use strict';

// Resposta de 16/11/2026, item 10 parte A (Lote 6). M7:82: "Entrada confirmada atualiza saldo e
// custo". Antes, uma linha de recebimento sem custo unitário era aceita na criação e, na
// confirmação, dava entrada no saldo sem nunca formar o custo médio do item (o indicador
// inventory_health_item_cost_completeness contava esse item como ACTIVE sem custo). Agora:
// - criar recebimento com qualquer linha sem custo dá 422 INVENTORY_RECEIPT_UNIT_COST_REQUIRED
//   (service e rota HTTP), sem gravar nada;
// - custo zero é aceito (>= 0) e forma custo médio 0, não nulo;
// - recebimento antigo, criado antes da trava, com linha sem custo, não confirma (mesmo código),
//   e nem saldo nem custo médio mudam.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.PORT = process.env.INVENTORY_RECEIPT_COST_HTTP_TEST_PORT || '21677';

require('../app');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const itemsService = require('../src/features/inventory/items.service');
const receiptsService = require('../src/features/inventory/receipts.service');
const { InventoryItem, InventoryReceipt, InventoryReceiptItem, InventoryMovement } = require('../src/models');

let tenant;
let baseUrl;
let token;

before(async () => {
  tenant = await getSeedTenant();
  token = signAccessToken({
    sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'],
    permissions: ['inventory:read', 'inventory:create', 'inventory:update'],
  });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

const actor = () => ({ userId: tenant.userId, canApprove: true });

async function createItemAndWarehouse(transaction) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const item = await itemsService.createItem(
    withTenant({ name: `HOMO QA Custo Receb ${suffix}`, sku: `RCU-${suffix}`, unitOfMeasure: 'UN' }),
    tenant.userId,
    transaction
  );
  const location = await itemsService.createLocation(
    withTenant({ name: `HOMO QA Custo Receb Deposito ${suffix}`, locationType: 'WAREHOUSE' }),
    tenant.userId,
    transaction
  );
  return { item, location };
}

function expectUnitCostRequired(err) {
  assert.equal(err.code, 'INVENTORY_RECEIPT_UNIT_COST_REQUIRED');
  assert.equal(err.statusCode, 422);
  return true;
}

test('M7:82: linha de recebimento sem custo unitário (ausente, nulo ou vazio) dá 422 e não grava o recebimento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const before = await InventoryReceipt.count({ where: { companyId: tenant.companyId }, transaction });
    const lines = [
      { inventoryItemId: item.id, quantity: 5 },
      { inventoryItemId: item.id, quantity: 5, unitCost: null },
      { inventoryItemId: item.id, quantity: 5, unitCost: '' },
      { inventoryItemId: item.id, quantity: 5, unitCost: '   ' },
    ];
    for (const line of lines) {
      await assert.rejects(
        () => receiptsService.createReceipt(withTenant({ destinationLocationId: location.id, items: [line] }), tenant.userId, transaction),
        expectUnitCostRequired
      );
    }
    // Uma linha com custo não salva a outra sem custo: o recebimento inteiro é recusado.
    await assert.rejects(
      () => receiptsService.createReceipt(
        withTenant({ destinationLocationId: location.id, items: [{ inventoryItemId: item.id, quantity: 2, unitCost: 10 }, { inventoryItemId: item.id, quantity: 3 }] }),
        tenant.userId,
        transaction
      ),
      expectUnitCostRequired
    );
    assert.equal(await InventoryReceipt.count({ where: { companyId: tenant.companyId }, transaction }), before);
  });
});

test('M7:82: custo negativo continua 400 INVENTORY_RECEIPT_VALIDATION; custo zero é aceito e forma custo médio 0 (não nulo)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    await assert.rejects(
      () => receiptsService.createReceipt(withTenant({ destinationLocationId: location.id, items: [{ inventoryItemId: item.id, quantity: 1, unitCost: -1 }] }), tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'INVENTORY_RECEIPT_VALIDATION'); return true; }
    );
    const receipt = await receiptsService.createReceipt(
      withTenant({ destinationLocationId: location.id, items: [{ inventoryItemId: item.id, quantity: 4, unitCost: 0 }] }),
      tenant.userId,
      transaction
    );
    await receiptsService.reviewReceipt(receipt.id, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await receiptsService.confirmReceipt(receipt.id, actor(), tenant.groupId, tenant.companyId, transaction);
    const reloaded = await InventoryItem.findByPk(item.id, { transaction });
    assert.notEqual(reloaded.averageCost, null, 'entrada confirmada sempre forma o custo médio');
    assert.equal(Number(reloaded.averageCost), 0);
  });
});

test('M7:82: recebimento antigo com linha sem custo não confirma; saldo, movimento e custo médio ficam como estavam', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    // Recebimento criado antes da trava da criação (linha sem custo gravada direto, como no legado).
    const receipt = await receiptsService.createReceipt(
      withTenant({ destinationLocationId: location.id, items: [{ inventoryItemId: item.id, quantity: 6, unitCost: 3 }] }),
      tenant.userId,
      transaction
    );
    await InventoryReceiptItem.create(
      withTenant({ receiptId: receipt.id, inventoryItemId: item.id, quantity: 2, unitCost: null }),
      { transaction }
    );
    await receiptsService.reviewReceipt(receipt.id, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await assert.rejects(
      () => receiptsService.confirmReceipt(receipt.id, actor(), tenant.groupId, tenant.companyId, transaction),
      expectUnitCostRequired
    );
    const reloadedReceipt = await InventoryReceipt.findByPk(receipt.id, { transaction });
    assert.equal(reloadedReceipt.status, 'REVIEWED');
    const reloadedItem = await InventoryItem.findByPk(item.id, { transaction });
    assert.equal(reloadedItem.averageCost, null, 'a linha com custo não é aplicada pela metade');
    assert.equal(await InventoryMovement.count({ where: { sourceType: 'RECEIPT', sourceId: receipt.id }, transaction }), 0);
  });
});

test('HTTP POST /inventory/receipts: linha sem custo unitário dá 422 INVENTORY_RECEIPT_UNIT_COST_REQUIRED', async () => {
  const res = await fetch(`${baseUrl}/inventory/receipts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      destinationLocationId: crypto.randomUUID(),
      items: [{ inventoryItemId: crypto.randomUUID(), quantity: 1, unitCost: 5 }, { inventoryItemId: crypto.randomUUID(), quantity: 1 }],
    }),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error.code, 'INVENTORY_RECEIPT_UNIT_COST_REQUIRED');
});
