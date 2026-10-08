'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const procurementService = require('../src/features/procurement/procurement.service');
const { Person, FinancialEntry } = require('../src/models');
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
    withTenant({ name: `AUDIT GAP Item ${suffix}`, sku: `SKU-AG-${suffix}`, unitOfMeasure: 'UN', ...extra }),
    tenant.userId,
    transaction
  );
  const location = await itemsService.createLocation(
    withTenant({ name: `AUDIT GAP Deposito ${Date.now()}${Math.floor(Math.random() * 10000)}`, locationType: 'WAREHOUSE' }),
    tenant.userId,
    transaction
  );
  return { item, location };
}

async function fullProcurementCycle(transaction, { item, location, quantity = 10, unitPrice = 3 }) {
  const request = await procurementService.createPurchaseRequest(
    withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity }] }),
    tenant.userId,
    transaction
  );
  await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', tenant.userId, transaction);
  const quotation = await procurementService.createQuotation(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  const offer = await procurementService.submitSupplierOffer(
    quotation.id,
    tenant.groupId,
    tenant.companyId,
    { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice }] },
    transaction
  );
  const order = await procurementService.awardSupplierOffer(offer.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  return { request, quotation, offer, order };
}

// Parte B, item 1 — cancelar uma PO já RECEIVED (com payable gerado) precisa estornar o
// FinancialEntry vinculado ao GoodsReceipt, não só marcar a PO como CANCELED.
test('cancelPurchaseOrder: cancelar PO RECEIVED com payable já criado estorna o FinancialEntry', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order } = await fullProcurementCycle(transaction, { item, location, quantity: 10, unitPrice: 3 });

    const { goodsReceipt } = await procurementService.confirmGoodsReceipt(
      order.id,
      tenant.groupId,
      tenant.companyId,
      { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 10 }] },
      actorOf(),
      transaction
    );
    assert.ok(goodsReceipt.financialEntryId, 'recebimento total precisa ter gerado o payable');

    const reloadedOrder = await procurementService.getPurchaseOrder(order.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(reloadedOrder.status, 'RECEIVED');

    const { order: canceled } = await procurementService.cancelPurchaseOrder(
      order.id, tenant.groupId, tenant.companyId, { reason: 'compra cancelada após recebimento total' }, actorOf(), transaction
    );
    assert.equal(canceled.status, 'CANCELED');

    const entry = await FinancialEntry.findByPk(goodsReceipt.financialEntryId, { transaction });
    assert.equal(entry.status, 'REVERSED', 'o payable gerado no recebimento precisa ser estornado ao cancelar a PO');
  });
});

// Parte B, item 2 — a checagem de invoiceFingerprint duplicado precisa rodar DEPOIS do lock
// FOR UPDATE do PurchaseOrder: duas chamadas concorrentes (mesma NF, PO diferente) não podem
// resultar em dois GoodsReceipt/payable para a mesma nota fiscal. Aqui validamos o
// comportamento sequencial (a segunda chamada sempre falha), que é o observável correto da
// correção — o teste de concorrência real (duas transações simultâneas) é coberto pela suíte
// de "loop até secar" de concorrência, fora do escopo deste arquivo de regressão pontual.
test('confirmGoodsReceipt: checagem de invoiceFingerprint duplicado roda mesmo após o lock do PO (ordem não quebra o bloqueio)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order: orderA } = await fullProcurementCycle(transaction, { item, location });
    const { item: item2, location: location2 } = await createItemAndWarehouse(transaction);
    const { order: orderB } = await fullProcurementCycle(transaction, { item: item2, location: location2 });

    const fingerprint = `NF-AUDIT-GAP-${uniqueSuffix()}`;

    await procurementService.confirmGoodsReceipt(
      orderA.id, tenant.groupId, tenant.companyId,
      { destinationLocationId: location.id, invoiceFingerprint: fingerprint, items: [{ purchaseOrderItemId: orderA.items[0].id, receivedQuantity: 10 }] },
      actorOf(),
      transaction
    );

    await assert.rejects(
      () => procurementService.confirmGoodsReceipt(
        orderB.id, tenant.groupId, tenant.companyId,
        { destinationLocationId: location2.id, invoiceFingerprint: fingerprint, items: [{ purchaseOrderItemId: orderB.items[0].id, receivedQuantity: 10 }] },
        actorOf(),
        transaction
      ),
      (err) => { assert.equal(err.code, 'GOODS_RECEIPT_DUPLICATE_INVOICE'); return true; }
    );
  });
});

// Parte B, item 3 — decideSupplierDueDiligence não pode decidir duas vezes a mesma due
// diligence (sem whitelist de status de origem, um APPROVED podia ser revertido pra REJECTED
// ou vice-versa depois de já ter sido usado para adjudicar uma PO).
test('decideSupplierDueDiligence: recusa decidir uma due diligence que já foi decidida', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const supplier = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PJ', legalName: `Fornecedor Audit Gap ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    const qualification = await procurementService.upsertSupplierQualification(
      withTenant({ supplierPersonId: supplier.id, highRisk: true }),
      tenant.userId,
      transaction
    );
    await procurementService.decideSupplierDueDiligence(qualification.id, tenant.groupId, tenant.companyId, { decision: 'APPROVED' }, actorOf(), transaction);

    await assert.rejects(
      () => procurementService.decideSupplierDueDiligence(qualification.id, tenant.groupId, tenant.companyId, { decision: 'REJECTED' }, actorOf(), transaction),
      (err) => { assert.equal(err.code, 'SUPPLIER_DUE_DILIGENCE_ALREADY_DECIDED'); return true; }
    );
  });
});

// Parte B, item 4 — upsertSupplierQualification precisa validar validUntil como data válida.
test('upsertSupplierQualification: recusa validUntil com formato de data inválido', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const supplier = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PJ', legalName: `Fornecedor Audit Gap Data ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    await assert.rejects(
      () => procurementService.upsertSupplierQualification(
        withTenant({ supplierPersonId: supplier.id, highRisk: true, validUntil: '2026-13-40' }),
        tenant.userId,
        transaction
      ),
      (err) => { assert.ok(err instanceof AppError); assert.equal(err.code, 'SUPPLIER_QUALIFICATION_VALIDATION'); return true; }
    );
  });
});

// Parte B, item 5 — invoiceTotalAmount precisa ser validado com Number.isFinite antes de
// entrar no three-way match/payable.
test('confirmGoodsReceipt: recusa invoiceTotalAmount inválido (NaN/Infinity/negativo)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order } = await fullProcurementCycle(transaction, { item, location });

    await assert.rejects(
      () => procurementService.confirmGoodsReceipt(
        order.id, tenant.groupId, tenant.companyId,
        { destinationLocationId: location.id, invoiceTotalAmount: Number.POSITIVE_INFINITY, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 10 }] },
        actorOf(),
        transaction
      ),
      (err) => { assert.equal(err.code, 'GOODS_RECEIPT_VALIDATION'); return true; }
    );

    await assert.rejects(
      () => procurementService.confirmGoodsReceipt(
        order.id, tenant.groupId, tenant.companyId,
        { destinationLocationId: location.id, invoiceTotalAmount: -10, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 10 }] },
        actorOf(),
        transaction
      ),
      (err) => { assert.equal(err.code, 'GOODS_RECEIPT_VALIDATION'); return true; }
    );
  });
});
