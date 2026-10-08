'use strict';

// LACUNA DE TESTE FECHADA (auditoria externa Nayara, 2026-10-07, Marco 7, EST-011): a fórmula de
// custo médio ponderado (receipts.service.js#confirmReceipt) só era exercitada com um único
// recebimento por teste — nenhum teste provava a média ponderada de verdade ao longo de
// múltiplos recebimentos com custos diferentes.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const receiptsService = require('../src/features/inventory/receipts.service');
const { InventoryItem } = require('../src/models');

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

async function createItemAndWarehouse(transaction) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const item = await itemsService.createItem(
    withTenant({ name: `HOMO QA AvgCost Item ${suffix}`, sku: `AVG-${suffix}`, unitOfMeasure: 'UN' }),
    tenant.userId,
    transaction
  );
  const location = await itemsService.createLocation(
    withTenant({ name: `HOMO QA AvgCost Deposito ${suffix}`, locationType: 'WAREHOUSE' }),
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

test('EST-011: custo médio ponderado acumula corretamente ao longo de 3 recebimentos com custos diferentes', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);

    // Recebimento 1: 100 un @ R$10,00 — primeiro recebimento, média = custo do próprio recebimento.
    await receive(transaction, item, location, 100, 10);
    let reloaded = await InventoryItem.findByPk(item.id, { transaction });
    assert.equal(Number(reloaded.averageCost), 10);

    // Recebimento 2: 50 un @ R$20,00 — média ponderada = (100*10 + 50*20) / 150 = 13.333...
    await receive(transaction, item, location, 50, 20);
    reloaded = await InventoryItem.findByPk(item.id, { transaction });
    assert.ok(
      Math.abs(Number(reloaded.averageCost) - 13.3333) < 0.001,
      `esperava ~13.3333, veio ${reloaded.averageCost}`
    );

    // Recebimento 3: 150 un @ R$5,00 — média ponderada = (150*13.3333 + 150*5) / 300 = 9.1666...
    await receive(transaction, item, location, 150, 5);
    reloaded = await InventoryItem.findByPk(item.id, { transaction });
    assert.ok(
      Math.abs(Number(reloaded.averageCost) - 9.1667) < 0.001,
      `esperava ~9.1667, veio ${reloaded.averageCost}`
    );
  });
});

test('EST-011: custo médio NÃO é contaminado pelo próprio recebimento ao calcular o denominador', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    // Um único recebimento grande: se o código somasse o saldo DEPOIS de aplicar o IN no
    // denominador, o resultado ainda seria o custo do próprio recebimento aqui (caso trivial
    // de 1 recebimento) — o teste anterior já cobre o caso que de fato expõe o bug (2º+
    // recebimento). Este aqui documenta o caso simples como regressão adicional.
    await receive(transaction, item, location, 10, 7.5);
    const reloaded = await InventoryItem.findByPk(item.id, { transaction });
    assert.equal(Number(reloaded.averageCost), 7.5);
  });
});
