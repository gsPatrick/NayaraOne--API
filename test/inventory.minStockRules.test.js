'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const minStockRules = require('../src/features/inventory/minStockRules.service');
const { OutboxEvent, Rule, RuleVersion, RuleScope, InventoryItem } = require('../src/models');
const AppError = require('../src/utils/AppError');

// GAP CORRIGIDO (auditoria de conformidade Marco 7, EST-012: "Estoque mínimo e reposição vêm do
// Motor de Regras"): o limiar do aviso inventory.stock.low era a coluna estática
// inventory_items.minimum_quantity. Estes testes provam que agora ele vem da regra REG-EST-001
// do Motor de Regras genérico (política por item, com override por local), versionada e imutável.

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

async function createItem(transaction, extra = {}) {
  const suffix = uniqueSuffix();
  return itemsService.createItem(
    withTenant({ name: `MINSTOCK Item ${suffix}`, sku: `MINSTOCK-${suffix}`, unitOfMeasure: 'UN', ...extra }),
    tenant.userId,
    transaction
  );
}

async function createWarehouse(transaction) {
  return itemsService.createLocation(withTenant({ name: `MINSTOCK Depósito ${uniqueSuffix()}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
}

async function move(transaction, item, type, qty, { source, destination } = {}) {
  return movementsService.recordMovement(
    withTenant({
      inventoryItemId: item.id,
      movementType: type,
      quantity: qty,
      sourceLocationId: source ? source.id : undefined,
      destinationLocationId: destination ? destination.id : undefined,
      reason: type === 'ADJUSTMENT' ? 'Ajuste de teste' : undefined,
    }),
    actor(),
    transaction
  );
}

async function stockLowEvents(transaction, itemId) {
  return OutboxEvent.findAll({ where: { aggregateId: itemId, eventType: 'inventory.stock.low' }, transaction });
}

function payloadOf(event) {
  return event.payloadJson || event.payload || event.get('payload_json') || {};
}

test('EST-012: estoque mínimo informado no cadastro vira versão REG-EST-001 (escopo OBJECT do item) no Motor de Regras', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const item = await createItem(transaction, { minimumQuantity: 10 });

    const rule = await Rule.findOne({ where: { code: 'REG-EST-001', companyId: tenant.companyId }, transaction });
    assert.ok(rule, 'regra REG-EST-001 precisa existir no core.rules');
    const scopes = await RuleScope.findAll({ where: { scopeType: 'OBJECT', scopeRefId: item.id }, transaction });
    assert.equal(scopes.length, 1, 'uma versão com escopo OBJECT = item');
    assert.equal(scopes[0].precedence, 1);
    const version = await RuleVersion.findByPk(scopes[0].ruleVersionId, { transaction });
    assert.equal(version.ruleId, rule.id);
    assert.equal(version.status, 'PUBLISHED');
    assert.equal(Number(version.actionJson.minimumQuantity), 10);

    const policy = await minStockRules.getMinStockPolicy(item, transaction, tenant.userId);
    assert.equal(policy.source, 'ITEM');
    assert.equal(policy.minimumQuantity, 10);
    assert.equal(policy.ruleVersionId, version.id);
  });
});

test('EST-012: inventory.stock.low usa o limiar do Motor de Regras, não a coluna minimum_quantity', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const item = await createItem(transaction, { minimumQuantity: 5 });
    const warehouse = await createWarehouse(transaction);

    // Nova versão da regra eleva o mínimo para 20.
    await minStockRules.createMinStockRule(withTenant({ inventoryItemId: item.id, minimumQuantity: 20, reorderQuantity: 50 }), tenant.userId, transaction);

    // Prova de que a coluna NÃO decide: força o espelho legado para um valor que não dispararia
    // aviso (saldo 15 >= 1). Se o código ainda lesse a coluna, nenhum evento sairia.
    await InventoryItem.update({ minimumQuantity: 1 }, { where: { id: item.id }, transaction });

    await move(transaction, item, 'IN', 15, { destination: warehouse });

    const events = await stockLowEvents(transaction, item.id);
    assert.equal(events.length, 1, 'saldo 15 < mínimo 20 da regra precisa disparar inventory.stock.low');
    const payload = payloadOf(events[0]);
    assert.equal(Number(payload.minimumQuantity), 20);
    assert.equal(Number(payload.reorderQuantity), 50);
    assert.equal(payload.ruleCode, 'REG-EST-001');
    assert.ok(payload.ruleVersionId, 'evento carrega a versão de regra que decidiu o aviso');
  });
});

test('EST-012: nova versão fecha a anterior (versionamento imutável, sem RULE_CONFLICT) e baixar o mínimo silencia o aviso', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const item = await createItem(transaction, { minimumQuantity: 100 });
    const warehouse = await createWarehouse(transaction);
    const first = await minStockRules.getMinStockPolicy(item, transaction, tenant.userId);

    const second = await minStockRules.createMinStockRule(withTenant({ inventoryItemId: item.id, minimumQuantity: 3 }), tenant.userId, transaction);
    assert.notEqual(second.id, first.ruleVersionId);

    const oldVersion = await RuleVersion.findByPk(first.ruleVersionId, { transaction });
    assert.ok(oldVersion.effectiveUntil, 'versão anterior do mesmo item tem a vigência fechada (nunca apagada)');
    assert.equal(Number(oldVersion.actionJson.minimumQuantity), 100, 'conteúdo da versão antiga nunca é editado');

    const current = await minStockRules.getMinStockPolicy(item, transaction, tenant.userId);
    assert.equal(current.ruleVersionId, second.id);
    assert.equal(current.minimumQuantity, 3);

    await item.reload({ transaction });
    assert.equal(Number(item.minimumQuantity), 3, 'coluna legada é espelho da versão vigente');

    await move(transaction, item, 'IN', 10, { destination: warehouse });
    assert.equal((await stockLowEvents(transaction, item.id)).length, 0, 'saldo 10 >= mínimo 3 vigente — sem aviso');
  });
});

test('EST-012: política por item/local — override por local prevalece sobre o mínimo padrão do item', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const item = await createItem(transaction);
    const central = await createWarehouse(transaction);
    const satellite = await createWarehouse(transaction);

    await minStockRules.createMinStockRule(
      withTenant({ inventoryItemId: item.id, minimumQuantity: 5, byLocation: { [satellite.id]: 50 } }),
      tenant.userId,
      transaction
    );

    await move(transaction, item, 'IN', 30, { destination: central });
    assert.equal((await stockLowEvents(transaction, item.id)).length, 0, 'central: 30 >= mínimo padrão 5');

    await move(transaction, item, 'TRANSFER', 20, { source: central, destination: satellite });
    const events = await stockLowEvents(transaction, item.id);
    assert.equal(events.length, 1, 'só o satélite (20 < override 50) avisa; central (10 >= 5) não');
    const payload = payloadOf(events[0]);
    assert.equal(payload.locationId, satellite.id);
    assert.equal(Number(payload.minimumQuantity), 50);
  });
});

test('EST-012: item sem política própria usa a política padrão GLOBAL semeada automaticamente (sem mínimo = sem aviso)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const item = await createItem(transaction);
    const warehouse = await createWarehouse(transaction);
    await move(transaction, item, 'IN', 1, { destination: warehouse });

    const policy = await minStockRules.getMinStockPolicy(item, transaction, tenant.userId);
    assert.equal(policy.source, 'DEFAULT');
    assert.equal(policy.minimumQuantity, null);
    const globalScope = await RuleScope.findOne({ where: { ruleVersionId: policy.ruleVersionId, scopeType: 'GLOBAL' }, transaction });
    assert.ok(globalScope, 'versão padrão da empresa é GLOBAL');
    assert.equal((await stockLowEvents(transaction, item.id)).length, 0);
  });
});

test('EST-012: item legado com minimum_quantity preenchido (antes da migração) é semeado no Motor de Regras uma única vez', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const item = await createItem(transaction);
    const warehouse = await createWarehouse(transaction);
    // Simula dado pré-migração: coluna preenchida, nenhuma versão de item no motor.
    await InventoryItem.update({ minimumQuantity: 8 }, { where: { id: item.id }, transaction });
    await item.reload({ transaction });

    await move(transaction, item, 'IN', 4, { destination: warehouse });
    const events = await stockLowEvents(transaction, item.id);
    assert.equal(events.length, 1, 'comportamento anterior preservado para dado legado');

    const scopes = await RuleScope.findAll({ where: { scopeType: 'OBJECT', scopeRefId: item.id }, transaction });
    assert.equal(scopes.length, 1, 'valor legado virou a versão própria do item no motor');

    // Segunda leitura não semeia de novo.
    await minStockRules.getMinStockPolicy(item, transaction, tenant.userId);
    const scopesAfter = await RuleScope.findAll({ where: { scopeType: 'OBJECT', scopeRefId: item.id }, transaction });
    assert.equal(scopesAfter.length, 1);
  });
});

test('EST-012: validação da política — quantidade negativa, local inexistente e SERVICE_ITEM são rejeitados', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const item = await createItem(transaction);
    await assert.rejects(
      () => minStockRules.createMinStockRule(withTenant({ inventoryItemId: item.id, minimumQuantity: -1 }), tenant.userId, transaction),
      (err) => err instanceof AppError && err.code === 'MIN_STOCK_RULE_VALIDATION'
    );
    await assert.rejects(
      () => minStockRules.createMinStockRule(
        withTenant({ inventoryItemId: item.id, minimumQuantity: 1, byLocation: { '00000000-0000-4000-8000-000000000000': 2 } }),
        tenant.userId,
        transaction
      ),
      (err) => err instanceof AppError && err.code === 'MIN_STOCK_RULE_LOCATION_NOT_FOUND'
    );
    const service = await createItem(transaction, { itemType: 'SERVICE_ITEM' });
    await assert.rejects(
      () => minStockRules.createMinStockRule(withTenant({ inventoryItemId: service.id, minimumQuantity: 1 }), tenant.userId, transaction),
      (err) => err instanceof AppError && err.code === 'MIN_STOCK_RULE_SERVICE_ITEM_FORBIDDEN'
    );
  });
});

function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body: JSON.parse(JSON.stringify(body)) }); return this; },
    };
    handler(req, res, reject);
  });
}

test('EST-012 (HTTP): POST/GET /inventory/items/:id/min-stock-rule publicam e leem a política via Motor de Regras', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const inventoryController = require('../src/features/inventory/inventory.controller');
    const item = await createItem(transaction);
    const warehouse = await createWarehouse(transaction);
    const auth = { userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, permissions: ['inventory:update', 'inventory:read'] };
    const withTenantTransaction = (fn) => fn(transaction);

    const created = await callController(inventoryController.createItemMinStockRule, {
      params: { id: item.id },
      body: { minimumQuantity: 7, reorderQuantity: 30, byLocation: { [warehouse.id]: 12 } },
      auth,
      withTenantTransaction,
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.data.ruleCode, 'REG-EST-001');

    const read = await callController(inventoryController.getItemMinStockRule, { params: { id: item.id }, body: {}, auth, withTenantTransaction });
    assert.equal(read.body.data.source, 'ITEM');
    assert.equal(read.body.data.minimumQuantity, 7);
    assert.equal(read.body.data.reorderQuantity, 30);
    assert.equal(Number(read.body.data.byLocation[warehouse.id]), 12);
    assert.equal(read.body.data.ruleVersionId, created.body.data.id);
  });
});
