'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const receiptsService = require('../src/features/inventory/receipts.service');
const movementsService = require('../src/features/inventory/movements.service');
const assetsService = require('../src/features/inventory/assets.service');
const procurementService = require('../src/features/procurement/procurement.service');
const countsService = require('../src/features/inventory/counts.service');
const { Person } = require('../src/models');
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
  return { userId: tenant.userId, canApprove: true, ...extra };
}

async function createItemAndWarehouse(transaction, extra = {}) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const item = await itemsService.createItem(
    withTenant({ name: `HOMO QA Item ${suffix}`, sku: `SKU-${suffix}`, unitOfMeasure: 'UN', ...extra }),
    tenant.userId,
    transaction
  );
  const location = await itemsService.createLocation(
    withTenant({ name: `HOMO QA Deposito ${Date.now()}${Math.floor(Math.random() * 10000)}`, locationType: 'WAREHOUSE' }),
    tenant.userId,
    transaction
  );
  return { item, location };
}

// EST-TS-01/EST-TS-08: recebimento duplicado pela mesma nota fiscal (invoiceFingerprint) não
// pode gerar entrada duplicada no estoque — bloqueio já na criação do receipt.

test('EST-TS-08: criar segundo recebimento com o mesmo invoiceFingerprint é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const fingerprint = `NF-DUP-${Date.now()}`;

    await receiptsService.createReceipt(
      withTenant({ destinationLocationId: location.id, invoiceFingerprint: fingerprint, items: [{ inventoryItemId: item.id, quantity: 10, unitCost: 5 }] }),
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () =>
        receiptsService.createReceipt(
          withTenant({ destinationLocationId: location.id, invoiceFingerprint: fingerprint, items: [{ inventoryItemId: item.id, quantity: 10, unitCost: 5 }] }),
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

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 57, 2026-10-06): createReceipt não
// validava unitCost — negativo corrompia o averageCost ponderado do item na confirmação.
test('INVENTORY_RECEIPT_VALIDATION: createReceipt recusa unitCost negativo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    await assert.rejects(
      () =>
        receiptsService.createReceipt(
          withTenant({ destinationLocationId: location.id, items: [{ inventoryItemId: item.id, quantity: 10, unitCost: -5 }] }),
          tenant.userId,
          transaction
        ),
      (err) => { assert.equal(err.code, 'INVENTORY_RECEIPT_VALIDATION'); return true; }
    );
  });
});

// EST-TS-01: confirmar um recebimento que já não está em REVIEWED (ex.: já COMPLETED) não pode
// gerar uma segunda entrada de estoque — a confirmação não é reentrante.

test('EST-TS-01: confirmar recebimento já COMPLETED é bloqueado e não duplica o saldo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const receipt = await receiptsService.createReceipt(
      withTenant({ destinationLocationId: location.id, items: [{ inventoryItemId: item.id, quantity: 10, unitCost: 5 }] }),
      tenant.userId,
      transaction
    );
    await receiptsService.reviewReceipt(receipt.id, tenant.userId, transaction);
    await receiptsService.confirmReceipt(receipt.id, actorOf(), transaction);

    const balanceAfterFirst = await movementsService.getBalance(item.id, location.id, transaction);
    assert.equal(balanceAfterFirst, 10);

    await assert.rejects(
      () => receiptsService.confirmReceipt(receipt.id, actorOf(), transaction),
      (err) => {
        assert.equal(err.code, 'INVENTORY_RECEIPT_INVALID_TRANSITION');
        return true;
      }
    );

    const balanceAfterSecondAttempt = await movementsService.getBalance(item.id, location.id, transaction);
    assert.equal(balanceAfterSecondAttempt, 10, 'saldo não pode ter sido duplicado por uma segunda tentativa de confirmação');
  });
});

// EST-002/documento "Banco de Dados Físico BLINDADO": OUT não pode gerar saldo negativo quando
// o item não permite estoque negativo — bloqueio de over-issue/over-receipt no lado de saída.

test('EST-002: movimento OUT que deixaria o saldo negativo é bloqueado quando allowNegativeStock=false', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction, { allowNegativeStock: false });
    const receipt = await receiptsService.createReceipt(
      withTenant({ destinationLocationId: location.id, items: [{ inventoryItemId: item.id, quantity: 5, unitCost: 2 }] }),
      tenant.userId,
      transaction
    );
    await receiptsService.reviewReceipt(receipt.id, tenant.userId, transaction);
    await receiptsService.confirmReceipt(receipt.id, actorOf(), transaction);

    await assert.rejects(
      () =>
        movementsService.recordMovement(
          withTenant({ inventoryItemId: item.id, movementType: 'OUT', quantity: 999, sourceLocationId: location.id, sourceType: 'MANUAL' }),
          actorOf(),
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INVENTORY_INSUFFICIENT_BALANCE');
        return true;
      }
    );

    const balance = await movementsService.getBalance(item.id, location.id, transaction);
    assert.equal(balance, 5, 'saldo não pode ter sido alterado por um movimento rejeitado');
  });
});

// EST-004: movimento que toca um local do tipo PROJECT_SITE exige projectId — sem isso o custo
// não pode ser rastreado corretamente até a obra.

test('EST-004: movimento envolvendo local PROJECT_SITE sem projectId é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item } = await createItemAndWarehouse(transaction);
    const siteLocation = await itemsService.createLocation(
      withTenant({ name: `HOMO QA Canteiro ${Date.now()}`, locationType: 'PROJECT_SITE' }),
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () =>
        movementsService.recordMovement(
          withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 10, destinationLocationId: siteLocation.id, sourceType: 'MANUAL' }),
          actorOf(),
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'INVENTORY_MOVEMENT_PROJECT_REQUIRED');
        return true;
      }
    );
  });
});

// Three-way match (Caderno Compras): over-receipt (recebido > saldo restante do PO) precisa
// abrir uma ReceiptDiscrepancy OPEN, em vez de ficar silenciosamente aceito.

test('Three-way match: over-receipt no recebimento de um PO abre ReceiptDiscrepancy OPEN', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);

    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);

    const { discrepancies } = await procurementService.confirmGoodsReceipt(
      order.id,
      { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 15 }] },
      actorOf(),
      transaction
    );

    assert.equal(discrepancies.length, 1);
    assert.equal(discrepancies[0].discrepancyType, 'OVER_RECEIPT');
    assert.equal(discrepancies[0].status, 'OPEN');
    assert.equal(Number(discrepancies[0].expectedValue), 10);
    assert.equal(Number(discrepancies[0].receivedValue), 15);

    // A baixa física real ainda ocorre (quantidade efetivamente recebida), delegada a inventory.receipts.
    const balance = await movementsService.getBalance(item.id, location.id, transaction);
    assert.equal(balance, 15);
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 58, 2026-10-06): o guard de unitPrice
// usava `Number(x) < 0`, falso para NaN — unitPrice:"NaN" passava (Postgres NUMERIC aceita o
// literal 'NaN'), corrompendo totalAmount/committedAmount do PO adjudicado.
test('Procurement: submitSupplierOffer recusa unitPrice "NaN" (literal numérico aceito pelo Postgres)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item } = await createItemAndWarehouse(transaction);
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    await assert.rejects(
      () => procurementService.submitSupplierOffer(
        quotation.id,
        { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 'NaN' }] },
        transaction
      ),
      (err) => { assert.equal(err.code, 'SUPPLIER_OFFER_VALIDATION'); return true; }
    );
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 58, 2026-10-06): mesmo bug em
// addCountItem — countedQuantity:"NaN" passava, persistindo divergence=NaN sem caminho de
// correção via API.
test('Inventory counts: addCountItem recusa countedQuantity "NaN"', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { location } = await createItemAndWarehouse(transaction);
    const count = await countsService.openCount(withTenant({ locationId: location.id }), tenant.userId, transaction);
    const { item } = await createItemAndWarehouse(transaction);
    await assert.rejects(
      () => countsService.addCountItem(count.id, { inventoryItemId: item.id, countedQuantity: 'NaN' }, transaction),
      (err) => { assert.equal(err.code, 'INVENTORY_COUNT_VALIDATION'); return true; }
    );
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 61, 2026-10-06): compareOffers nunca
// incluía o nome do fornecedor — a tela de comparação mostrava supplierPersonId cru (UUID).
test('Procurement: compareOffers inclui o nome do fornecedor (supplierPersonName)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item } = await createItemAndWarehouse(transaction);
    const supplier = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PJ', legalName: `Fornecedor Teste ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: supplier.id, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );

    const offers = await procurementService.compareOffers(quotation.id, transaction);
    assert.equal(offers.length, 1);
    assert.equal(offers[0].supplierPersonName, supplier.legalName);
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 62, 2026-10-06): listPurchaseOrders/
// getPurchaseOrder nunca incluíam o nome do fornecedor (mesma classe do compareOffers, um passo
// adiante no funil — tela de Pedidos de Compra mostrava UUID cru).
test('Procurement: listPurchaseOrders/getPurchaseOrder incluem supplierPersonName', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item } = await createItemAndWarehouse(transaction);
    const supplier = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PJ', legalName: `Fornecedor PO Teste ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: supplier.id, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);
    assert.equal(order.supplierPersonName, supplier.legalName);

    const fetched = await procurementService.getPurchaseOrder(order.id, transaction);
    assert.equal(fetched.supplierPersonName, supplier.legalName);

    const listed = await procurementService.listPurchaseOrders(transaction, {});
    const found = listed.find((o) => o.id === order.id);
    assert.equal(found.supplierPersonName, supplier.legalName);
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 57, 2026-10-06): awardSupplierOffer só
// validava o status da SupplierOffer, nunca o da Quotation — uma cotação com 2 ofertas RECEIVED
// podia ser adjudicada duas vezes, gerando dois PurchaseOrder concorrentes pra mesma requisição.
test('Procurement: awardSupplierOffer recusa adjudicar uma segunda oferta da mesma cotação já fechada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item } = await createItemAndWarehouse(transaction);
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offerA = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );
    const offerB = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 4 }] },
      transaction
    );

    await procurementService.awardSupplierOffer(offerA.id, tenant.userId, transaction);
    await assert.rejects(
      () => procurementService.awardSupplierOffer(offerB.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'QUOTATION_ALREADY_AWARDED'); return true; }
    );
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 56, 2026-10-06): confirmGoodsReceipt
// não validava receivedQuantity <= 0 — um valor negativo decrementava poItem.receivedQuantity
// silenciosamente, sem discrepância e sem baixa de estoque, desalinhando o saldo do PO.
test('Three-way match: confirmGoodsReceipt recusa receivedQuantity <= 0', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);

    await assert.rejects(
      () => procurementService.confirmGoodsReceipt(
        order.id,
        { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: -5 }] },
        actorOf(),
        transaction
      ),
      (err) => { assert.equal(err.code, 'GOODS_RECEIPT_INVALID_QUANTITY'); return true; }
    );
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 64, 2026-10-06): confirmGoodsReceipt
// não tinha proteção real contra duplo-processamento em recebimento PARCIAL (PO continua OPEN) —
// a idempotencyKey antiga do payable era derivada de goodsReceipt.id, gerado dentro da própria
// chamada, nunca podendo colidir. Agora aceita idempotencyKey do cliente, única por empresa.
test('Three-way match: confirmGoodsReceipt com idempotencyKey repetida em recebimento PARCIAL não duplica GoodsReceipt nem payable', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);
    const idempotencyKey = `test-retry-${uniqueSuffix()}`;

    const first = await procurementService.confirmGoodsReceipt(
      order.id,
      { destinationLocationId: location.id, idempotencyKey, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 4 }] },
      actorOf(),
      transaction
    );
    // Recebimento parcial: 4 de 10 — PO continua OPEN, único jeito de a proteção antiga falhar.
    const reloadedOrder = await procurementService.getPurchaseOrder(order.id, transaction);
    assert.equal(reloadedOrder.status, 'OPEN');

    const retry = await procurementService.confirmGoodsReceipt(
      order.id,
      { destinationLocationId: location.id, idempotencyKey, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 4 }] },
      actorOf(),
      transaction
    );
    assert.equal(retry.goodsReceipt.id, first.goodsReceipt.id, 'retry com a mesma idempotencyKey devia retornar o mesmo recebimento, não criar outro');

    const balance = await movementsService.getBalance(item.id, location.id, transaction);
    assert.equal(balance, 4, 'retry não pode ter duplicado a entrada de estoque');
  });
});

// Bug real corrigido nesta auditoria (rodada 12, 2026-10-05): a ReceiptDiscrepancy tinha
// `status` com DEFAULT 'OPEN' projetado pra ter transição, mas nada no sistema jamais a
// resolvia — ficava eternamente OPEN. `resolveDiscrepancy` fecha o case de verdade.
test('Three-way match: resolveDiscrepancy fecha o case (ACCEPTED/REJECTED) e rejeita resolver de novo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);
    const { discrepancies } = await procurementService.confirmGoodsReceipt(
      order.id,
      { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 15 }] },
      actorOf(),
      transaction
    );
    const discrepancy = discrepancies[0];

    await assert.rejects(
      () => procurementService.resolveDiscrepancy(discrepancy.id, { resolution: 'MAYBE' }, { userId: tenant.userId }, transaction),
      (err) => {
        assert.equal(err.code, 'RECEIPT_DISCREPANCY_VALIDATION');
        return true;
      }
    );

    const resolved = await procurementService.resolveDiscrepancy(
      discrepancy.id,
      { resolution: 'accepted', notes: 'Excedente aceito pelo comprador.' },
      { userId: tenant.userId },
      transaction
    );
    assert.equal(resolved.status, 'ACCEPTED');
    assert.equal(resolved.resolvedByUserId, tenant.userId);
    assert.ok(resolved.resolvedAt);

    await assert.rejects(
      () => procurementService.resolveDiscrepancy(discrepancy.id, { resolution: 'REJECTED' }, { userId: tenant.userId }, transaction),
      (err) => {
        assert.equal(err.code, 'RECEIPT_DISCREPANCY_INVALID_STATUS');
        return true;
      }
    );
  });
});

// Caderno Compras: só é possível receber mercadoria de um PO que esteja OPEN — impede
// recebimento duplo contra o mesmo pedido já totalmente recebido/fechado.

test('Recebimento contra PO que não está OPEN é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);

    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);

    await procurementService.confirmGoodsReceipt(
      order.id,
      { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 10 }] },
      actorOf(),
      transaction
    );

    await assert.rejects(
      () =>
        procurementService.confirmGoodsReceipt(
          order.id,
          { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 1 }] },
          actorOf(),
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'PURCHASE_ORDER_INVALID_TRANSITION');
        return true;
      }
    );
  });
});

// Bug real corrigido nesta auditoria (rodada 17, 2026-10-05): SupplierEvaluation era write-only
// — evaluateSupplier gravava, mas não existia endpoint/serviço algum pra ler a avaliação depois.
// Mesma família de bug "dado gravado e nunca lido" das rodadas 7/8/9/10.
test('Avaliação de fornecedor: listSupplierEvaluations lê as avaliações e calcula a nota média', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const supplierPersonId = tenant.userId;
    await procurementService.evaluateSupplier(
      withTenant({ supplierPersonId, score: 4, notes: 'Entrega no prazo.' }),
      tenant.userId,
      transaction
    );
    await procurementService.evaluateSupplier(
      withTenant({ supplierPersonId, score: 2, notes: 'Material com avaria.' }),
      tenant.userId,
      transaction
    );

    const result = await procurementService.listSupplierEvaluations(transaction, { supplierPersonId });
    assert.equal(result.count, 2);
    assert.equal(result.averageScore, 3);
    assert.equal(result.evaluations.length, 2);
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 59, 2026-10-06): guard de score sem
// Number.isFinite — score:"NaN" passava e corrompia getAverageScore pra sempre.
test('Avaliação de fornecedor: evaluateSupplier recusa score "NaN"', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => procurementService.evaluateSupplier(
        withTenant({ supplierPersonId: tenant.userId, score: 'NaN' }),
        tenant.userId,
        transaction
      ),
      (err) => { assert.equal(err.code, 'SUPPLIER_EVALUATION_VALIDATION'); return true; }
    );
  });
});

// Bug real corrigido nesta auditoria (rodada 25, 2026-10-05): o contrato exige three-way match
// "PO x receipt x invoice" e "invoice match = payable idempotente" — confirmGoodsReceipt só
// comparava quantidade (PO x receipt), nunca o valor da nota fiscal, e nunca criava o contas a
// pagar a partir do recebimento confirmado (fluxo RECEIPT -> MATCH -> PAYABLE documentado no
// próprio cabeçalho do arquivo, nunca implementado).
test('Invoice match: valor da NF igual ao esperado confirma o recebimento e cria o payable idempotente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);

    const { goodsReceipt, discrepancies } = await procurementService.confirmGoodsReceipt(
      order.id,
      { destinationLocationId: location.id, invoiceTotalAmount: 30, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 10 }] },
      actorOf(),
      transaction
    );
    assert.equal(discrepancies.length, 0, 'NF batendo com o esperado (10 x 3 = 30) não pode abrir divergência');
    assert.ok(goodsReceipt.financialEntryId, 'recebimento confirmado precisa gerar o payable (fluxo RECEIPT -> MATCH -> PAYABLE)');

    const { FinancialEntry } = require('../src/models');
    const entry = await FinancialEntry.findByPk(goodsReceipt.financialEntryId, { transaction });
    assert.equal(entry.entryType, 'DEBIT');
    assert.equal(entry.nature, 'PAYABLE');
    assert.equal(Number(entry.amount), 30);
  });
});

test('Invoice match: valor da NF diferente do esperado abre ReceiptDiscrepancy PRICE_MISMATCH', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);

    // Esperado: 10 x 3 = 30. NF vem cobrando 45 — divergência de preço real.
    const { discrepancies } = await procurementService.confirmGoodsReceipt(
      order.id,
      { destinationLocationId: location.id, invoiceTotalAmount: 45, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 10 }] },
      actorOf(),
      transaction
    );
    assert.equal(discrepancies.length, 1);
    assert.equal(discrepancies[0].discrepancyType, 'PRICE_MISMATCH');
    assert.equal(Number(discrepancies[0].expectedValue), 30);
    assert.equal(Number(discrepancies[0].receivedValue), 45);
  });
});

// Bug real corrigido nesta auditoria (rodada 26, 2026-10-05): rejeitar uma PRICE_MISMATCH só
// mudava o status da divergência — o payable continuava com o valor contestado da nota fiscal.
// Agora a rejeição estorna o payable errado e cria um corrigido com o valor esperado.
test('Invoice match: rejeitar PRICE_MISMATCH estorna o payable errado e cria um corrigido com o valor esperado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);

    const { goodsReceipt, discrepancies } = await procurementService.confirmGoodsReceipt(
      order.id,
      { destinationLocationId: location.id, invoiceTotalAmount: 45, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 10 }] },
      actorOf(),
      transaction
    );
    const wrongPayableId = goodsReceipt.financialEntryId;
    assert.ok(wrongPayableId);

    await procurementService.resolveDiscrepancy(discrepancies[0].id, { resolution: 'REJECTED' }, { userId: tenant.userId }, transaction);

    const { FinancialEntry } = require('../src/models');
    const wrongPayable = await FinancialEntry.findByPk(wrongPayableId, { transaction });
    assert.equal(wrongPayable.status, 'REVERSED', 'payable com valor contestado precisa ser estornado');

    await goodsReceipt.reload({ transaction });
    assert.notEqual(goodsReceipt.financialEntryId, wrongPayableId, 'recebimento precisa apontar pro novo payable corrigido');
    const correctedPayable = await FinancialEntry.findByPk(goodsReceipt.financialEntryId, { transaction });
    assert.equal(Number(correctedPayable.amount), 30, 'payable corrigido precisa usar o valor esperado (PO x quantidade), não o da nota contestada');
    assert.equal(correctedPayable.status, 'PENDING');
  });
});

// Bug real corrigido nesta auditoria (rodada 27, 2026-10-05): não existia NENHUM endpoint pra
// listar/consultar recebimentos (GoodsReceipt) depois de confirmados — o front não tinha como
// mostrar o payable gerado/corrigido (R25/R26) nem o histórico de recebimentos de um PO.
test('listGoodsReceipts lê os recebimentos de um PO, incluindo o payable vinculado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);
    const { goodsReceipt } = await procurementService.confirmGoodsReceipt(
      order.id,
      { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 10 }] },
      actorOf(),
      transaction
    );

    const receipts = await procurementService.listGoodsReceipts(transaction, { purchaseOrderId: order.id });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].id, goodsReceipt.id);
    assert.ok(receipts[0].financialEntryId, 'listagem precisa expor o payable vinculado ao recebimento');
  });
});

// Bug real corrigido nesta auditoria (rodada 47, 2026-10-05): o contrato (TAB-0750) trata sku
// e unit_code (unit_of_measure) como NOT NULL, com UNIQUE(company_id, sku) — mas nada exigia
// esses campos nem impedia SKU duplicado.
test('TAB-0750: createItem exige sku/unitOfMeasure e bloqueia SKU duplicado na mesma empresa', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    await assert.rejects(
      () => itemsService.createItem(withTenant({ name: `Item sem sku ${suffix}`, unitOfMeasure: 'UN' }), tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'INVENTORY_ITEM_VALIDATION'); return true; }
    );
    await assert.rejects(
      () => itemsService.createItem(withTenant({ name: `Item sem unidade ${suffix}`, sku: `SKU-${suffix}` }), tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'INVENTORY_ITEM_VALIDATION'); return true; }
    );

    await itemsService.createItem(withTenant({ name: `Item 1 ${suffix}`, sku: `DUP-${suffix}`, unitOfMeasure: 'UN' }), tenant.userId, transaction);
    await assert.rejects(
      () => itemsService.createItem(withTenant({ name: `Item 2 ${suffix}`, sku: `DUP-${suffix}`, unitOfMeasure: 'UN' }), tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'INVENTORY_ITEM_DUPLICATE_SKU'); return true; }
    );
  });
});

// Bug real corrigido nesta auditoria (rodada 47): TAB-0760 trata asset_tag como NOT NULL com
// UNIQUE(company_id, asset_tag) — era possível criar patrimônio sem tag, e a checagem de
// duplicidade não era escopada por empresa.
test('TAB-0760: createAsset exige assetTag e a unicidade é por empresa, não global', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    await assert.rejects(
      () => assetsService.createAsset(withTenant({ name: `Asset sem tag ${suffix}` }), tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'ASSET_VALIDATION'); return true; }
    );

    await assetsService.createAsset(withTenant({ name: `Asset 1 ${suffix}`, assetTag: `TAG-${suffix}` }), tenant.userId, transaction);
    await assert.rejects(
      () => assetsService.createAsset(withTenant({ name: `Asset 2 ${suffix}`, assetTag: `TAG-${suffix}` }), tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'ASSET_DUPLICATE_TAG'); return true; }
    );
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 56, 2026-10-06): createAsset/updateAsset
// não validavam acquisitionValue — aceitavam negativo sem checagem.
test('TAB-0760: createAsset/updateAsset recusam acquisitionValue negativo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    await assert.rejects(
      () => assetsService.createAsset(withTenant({ name: `Asset negativo ${suffix}`, assetTag: `TAGNEG-${suffix}`, acquisitionValue: -100 }), tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'ASSET_VALIDATION'); return true; }
    );

    const asset = await assetsService.createAsset(withTenant({ name: `Asset válido ${suffix}`, assetTag: `TAGOK-${suffix}`, acquisitionValue: 100 }), tenant.userId, transaction);
    await assert.rejects(
      () => assetsService.updateAsset(asset.id, { acquisitionValue: -50 }, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'ASSET_VALIDATION'); return true; }
    );
  });
});

// Bug real corrigido nesta auditoria (rodada 47): TAB-0751 trata created_by como NOT NULL —
// ledger imutável de estoque sem autor quebra rastreabilidade.
test('TAB-0751: recordMovement exige actor.userId (ledger imutável não pode ter autor nulo)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    await assert.rejects(
      () =>
        movementsService.recordMovement(
          withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 1, destinationLocationId: location.id, sourceType: 'MANUAL' }),
          { userId: null, canApprove: true },
          transaction
        ),
      (err) => { assert.equal(err.code, 'INVENTORY_MOVEMENT_ACTOR_REQUIRED'); return true; }
    );
  });
});

// Bug real corrigido nesta auditoria (rodada 53, 2026-10-05): listRequisitions não incluía os
// itens da requisição (só getRequisition incluía) — a tela de lista nunca mostrava quais itens
// foram solicitados, só o status agregado.
test('TAB-estoque: listRequisitions inclui os itens da requisição, não só o status agregado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const requisitionsService = require('../src/features/inventory/requisitions.service');
    const { item, location } = await createItemAndWarehouse(transaction);
    await requisitionsService.createRequisition(
      withTenant({ warehouseLocationId: location.id, items: [{ inventoryItemId: item.id, quantity: 3 }] }),
      tenant.userId,
      transaction
    );

    const list = await requisitionsService.listRequisitions(transaction, {});
    const found = list.find((r) => Array.isArray(r.items) && r.items.some((it) => it.inventoryItemId === item.id));
    assert.ok(found, 'listRequisitions precisa incluir os itens, não só o registro agregado');
    assert.equal(Number(found.items[0].quantity), 3);
  });
});

// Auditoria contratual (2026-10-07): "Cancel/return = compensação" (Anexo I) — cancelar uma PO
// com saldo ainda não recebido precisa abrir uma UNDER_RECEIPT auditável, nunca sumir com a
// diferença em silêncio.
test('Procurement: cancelPurchaseOrder com recebimento parcial abre UNDER_RECEIPT e marca CANCELED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);

    await procurementService.confirmGoodsReceipt(
      order.id,
      { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 4 }] },
      actorOf(),
      transaction
    );

    const { order: canceled, discrepancies } = await procurementService.cancelPurchaseOrder(order.id, { reason: 'fornecedor não vai entregar o restante' }, actorOf(), transaction);

    assert.equal(canceled.status, 'CANCELED');
    assert.equal(discrepancies.length, 1);
    assert.equal(discrepancies[0].discrepancyType, 'UNDER_RECEIPT');
    assert.equal(Number(discrepancies[0].expectedValue), 10);
    assert.equal(Number(discrepancies[0].receivedValue), 4);
    assert.equal(discrepancies[0].status, 'OPEN');
  });
});

test('Procurement: cancelPurchaseOrder recusa cancelar PO já CANCELED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item } = await createItemAndWarehouse(transaction);
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);
    await procurementService.cancelPurchaseOrder(order.id, {}, actorOf(), transaction);

    await assert.rejects(
      () => procurementService.cancelPurchaseOrder(order.id, {}, actorOf(), transaction),
      (err) => { assert.equal(err.code, 'PURCHASE_ORDER_INVALID_TRANSITION'); return true; }
    );
  });
});

// Auditoria contratual (2026-10-07): "Fornecedores: documentos/vigência; due diligence para
// alto risco" (Anexo I) — fornecedor alto risco sem due diligence aprovada não pode ser
// adjudicado.
async function createSupplierPerson(transaction) {
  return Person.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PJ', legalName: `Fornecedor Teste ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
}

test('Procurement: awardSupplierOffer bloqueia fornecedor de alto risco sem due diligence aprovada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item } = await createItemAndWarehouse(transaction);
    const supplier = await createSupplierPerson(transaction);
    await procurementService.upsertSupplierQualification(
      withTenant({ supplierPersonId: supplier.id, highRisk: true }),
      tenant.userId,
      transaction
    );

    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: supplier.id, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );

    await assert.rejects(
      () => procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'SUPPLIER_DUE_DILIGENCE_REQUIRED'); return true; }
    );
  });
});

test('Procurement: awardSupplierOffer libera fornecedor de alto risco com due diligence APPROVED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item } = await createItemAndWarehouse(transaction);
    const supplier = await createSupplierPerson(transaction);
    const qualification = await procurementService.upsertSupplierQualification(
      withTenant({ supplierPersonId: supplier.id, highRisk: true, validUntil: '2099-12-31' }),
      tenant.userId,
      transaction
    );
    await procurementService.decideSupplierDueDiligence(qualification.id, { decision: 'APPROVED' }, actorOf(), transaction);

    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(
      quotation.id,
      { supplierPersonId: supplier.id, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] },
      transaction
    );

    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);
    assert.equal(order.status, 'OPEN');
  });
});

test('Procurement: decideSupplierDueDiligence recusa aprovar fornecedor que não é alto risco', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const supplier = await createSupplierPerson(transaction);
    const qualification = await procurementService.upsertSupplierQualification(
      withTenant({ supplierPersonId: supplier.id, highRisk: false }),
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => procurementService.decideSupplierDueDiligence(qualification.id, { decision: 'APPROVED' }, actorOf(), transaction),
      (err) => { assert.equal(err.code, 'SUPPLIER_QUALIFICATION_NOT_HIGH_RISK'); return true; }
    );
  });
});
