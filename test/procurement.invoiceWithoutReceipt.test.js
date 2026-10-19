'use strict';

// Marco 7, addendum Compras — linha "T-invoice sem receipt" da matriz.
//
// Regra: nota fiscal/fatura de compra só vira contas a pagar DENTRO de um recebimento confirmado
// contra um pedido em aberto (PO → RECEIPT → MATCH → PAYABLE). Não existe caminho para lançar a
// NF "solta". Até aqui isso era verdade por construção; este arquivo PROVA, tentando de fato:
//   Serviço (confirmGoodsReceipt / createReceipt / awardSupplierOffer):
//     1. NF com valor mas sem nenhum item recebido (items: [])            → recusada, nada gravado
//     2. NF sem o campo items                                              → recusada, nada gravado
//     3. NF com linha de quantidade 0 ("recebi zero")                      → recusada, nada gravado
//     4. NF contra pedido que não está em aberto (cancelado)               → recusada, nada gravado
//     5. Pedido adjudicado (compromisso) sem recebimento                   → nenhum payable
//     6. Recibo de Estoque com número de NF, mas não confirmado            → nem saldo nem payable
//   Rota (HTTP real, JWT/tenant/RLS reais):
//     7. POST /procurement/purchase-orders/:id/goods-receipts só com a NF → 400, nada gravado
//     8. Não há rota de "lançar NF de compra" avulsa                       → 404
//   E o controle positivo: com o recebimento, a mesma NF gera exatamente 1 payable.
//
// "Nada gravado" = nenhum GoodsReceipt do pedido e nenhum FinancialEntry cuja descrição cite o
// pedido (o payable de compra sempre leva "PO <id>" na descrição — ver confirmGoodsReceipt).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.INVOICE_NO_RECEIPT_HTTP_TEST_PORT || '21597';

const app = require('../app'); // eslint-disable-line no-unused-vars
const { Op } = require('sequelize');
const { sequelize, getSeedTenant, withTenantTransaction, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const procurementService = require('../src/features/procurement/procurement.service');
const itemsService = require('../src/features/inventory/items.service');
const receiptsService = require('../src/features/inventory/receipts.service');
const {
  Person, PurchaseRequest, PurchaseRequestItem, Quotation, SupplierOffer, SupplierOfferItem,
  PurchaseOrder, PurchaseOrderItem, GoodsReceipt, FinancialEntry, InventoryMovement, InventoryStockBalance,
  InventoryItem, InventoryLocation, User,
} = require('../src/models');

let tenant;
let token;
let baseUrl;
let secondApprover;
const created = { personIds: [], requestIds: [], orderIds: [], itemIds: [], locationIds: [] };

before(async () => {
  tenant = await getSeedTenant();
  token = signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions: ['procurement:read', 'procurement:create', 'procurement:approve', 'finance:read'] });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  secondApprover = await User.create({ name: `QA NF sem recebimento ${uniqueSuffix()}`, email: `qa-nf-sem-receb-${uniqueSuffix()}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' });
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await withTenantTransaction(tenant, async (transaction) => {
    if (created.orderIds.length) {
      await PurchaseOrderItem.destroy({ where: { purchaseOrderId: created.orderIds }, force: true, transaction });
      await PurchaseOrder.destroy({ where: { id: created.orderIds }, force: true, transaction });
    }
    if (created.requestIds.length) {
      const quotations = await Quotation.findAll({ where: { purchaseRequestId: created.requestIds }, transaction });
      const quotationIds = quotations.map((q) => q.id);
      if (quotationIds.length) {
        const offerIds = (await SupplierOffer.findAll({ where: { quotationId: quotationIds }, transaction })).map((o) => o.id);
        if (offerIds.length) {
          await SupplierOfferItem.destroy({ where: { supplierOfferId: offerIds }, force: true, transaction });
          await SupplierOffer.destroy({ where: { id: offerIds }, force: true, transaction });
        }
        await Quotation.destroy({ where: { id: quotationIds }, force: true, transaction });
      }
      await PurchaseRequestItem.destroy({ where: { purchaseRequestId: created.requestIds }, force: true, transaction });
      await PurchaseRequest.destroy({ where: { id: created.requestIds }, force: true, transaction });
    }
    if (created.itemIds.length) await InventoryItem.destroy({ where: { id: created.itemIds }, force: true, transaction });
    if (created.locationIds.length) await InventoryLocation.destroy({ where: { id: created.locationIds }, force: true, transaction });
    if (created.personIds.length) await Person.destroy({ where: { id: created.personIds }, force: true, transaction });
  }).catch((err) => console.error('[procurement.invoiceWithoutReceipt] limpeza falhou:', err.message));
  if (secondApprover) await User.destroy({ where: { id: secondApprover.id }, force: true }).catch(() => {});
  await sequelize.close();
  process.exit(0);
});

const withTenant = (fields) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields });
const actor = () => ({ userId: tenant.userId, canApprove: false });

async function buildOpenOrder(transaction) {
  const supplier = await Person.create(withTenant({ personType: 'PJ', legalName: `QA NF Fornecedor ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId }), { transaction });
  const item = await itemsService.createItem(withTenant({ name: `QA NF Item ${uniqueSuffix()}`, sku: `QANF-${uniqueSuffix()}`, unitOfMeasure: 'UN' }), tenant.userId, transaction);
  const warehouse = await itemsService.createLocation(withTenant({ name: `QA NF Depósito ${uniqueSuffix()}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
  const request = await procurementService.createPurchaseRequest(withTenant({ items: [{ inventoryItemId: item.id, description: 'Cimento', quantity: 10 }] }), tenant.userId, transaction);
  await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', secondApprover.id, transaction);
  const quotation = await procurementService.createQuotation(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  const offer = await procurementService.submitSupplierOffer(quotation.id, tenant.groupId, tenant.companyId, { supplierPersonId: supplier.id, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 40 }] }, transaction);
  const order = await procurementService.awardSupplierOffer(offer.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  const poItems = await PurchaseOrderItem.findAll({ where: { purchaseOrderId: order.id }, transaction });
  return { supplier, item, warehouse, request, order, poItem: poItems[0] };
}

async function traces(orderId, transaction) {
  const receipts = await GoodsReceipt.count({ where: { purchaseOrderId: orderId }, transaction });
  const payables = await FinancialEntry.count({ where: { description: { [Op.like]: `%PO ${orderId}%` } }, transaction });
  return { receipts, payables };
}

async function assertRejectedWithoutTrace(transaction, orderId, fn, code) {
  // Savepoint: o erro do serviço não pode abortar a transação de teste antes da contagem.
  const sp = await sequelize.transaction({ transaction });
  await assert.rejects(fn(sp), (err) => {
    assert.equal(err.code, code);
    return true;
  });
  await sp.rollback();
  assert.deepEqual(await traces(orderId, transaction), { receipts: 0, payables: 0 }, 'NF recusada não pode deixar recebimento nem payable');
}

test('T-invoice sem receipt (serviço): NF com valor e sem itens recebidos é recusada e não gera payable', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { order, warehouse } = await buildOpenOrder(transaction);
    assert.deepEqual(await traces(order.id, transaction), { receipts: 0, payables: 0 }, 'pedido adjudicado = compromisso, ainda sem payable');
    const invoice = { destinationLocationId: warehouse.id, invoiceFingerprint: `NF-${uniqueSuffix()}`, invoiceTotalAmount: 400 };

    await assertRejectedWithoutTrace(transaction, order.id,
      (t) => procurementService.confirmGoodsReceipt(order.id, tenant.groupId, tenant.companyId, { ...invoice, items: [] }, actor(), t), 'GOODS_RECEIPT_VALIDATION');
    await assertRejectedWithoutTrace(transaction, order.id,
      (t) => procurementService.confirmGoodsReceipt(order.id, tenant.groupId, tenant.companyId, invoice, actor(), t), 'GOODS_RECEIPT_VALIDATION');
  });
});

test('T-invoice sem receipt (serviço): NF com linha de quantidade zero é recusada e não gera payable', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { order, warehouse, poItem } = await buildOpenOrder(transaction);
    await assertRejectedWithoutTrace(transaction, order.id,
      (t) => procurementService.confirmGoodsReceipt(order.id, tenant.groupId, tenant.companyId,
        { destinationLocationId: warehouse.id, invoiceFingerprint: `NF-${uniqueSuffix()}`, invoiceTotalAmount: 400, items: [{ purchaseOrderItemId: poItem.id, receivedQuantity: 0 }] }, actor(), t),
      'GOODS_RECEIPT_INVALID_QUANTITY');
    const fresh = await PurchaseOrderItem.findByPk(poItem.id, { transaction });
    assert.equal(Number(fresh.receivedQuantity), 0, 'quantidade recebida do pedido continua zero');
  });
});

test('T-invoice sem receipt (serviço): NF contra pedido cancelado é recusada e não gera payable', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { order, warehouse, poItem } = await buildOpenOrder(transaction);
    await procurementService.cancelPurchaseOrder(order.id, tenant.groupId, tenant.companyId, { reason: 'Fornecedor desistiu' }, { userId: tenant.userId, canApprove: true }, transaction);
    await assertRejectedWithoutTrace(transaction, order.id,
      (t) => procurementService.confirmGoodsReceipt(order.id, tenant.groupId, tenant.companyId,
        { destinationLocationId: warehouse.id, invoiceFingerprint: `NF-${uniqueSuffix()}`, invoiceTotalAmount: 400, items: [{ purchaseOrderItemId: poItem.id, receivedQuantity: 10 }] }, actor(), t),
      'PURCHASE_ORDER_INVALID_TRANSITION');
  });
});

test('T-invoice sem receipt (Estoque): recibo com número de NF não confirmado não move saldo nem cria payable', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const item = await itemsService.createItem(withTenant({ name: `QA NF Estoque ${uniqueSuffix()}`, sku: `QANFE-${uniqueSuffix()}`, unitOfMeasure: 'UN' }), tenant.userId, transaction);
    const warehouse = await itemsService.createLocation(withTenant({ name: `QA NF Est Depósito ${uniqueSuffix()}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
    const invoiceNumber = `NFE-${uniqueSuffix()}`;
    const receipt = await receiptsService.createReceipt(withTenant({ destinationLocationId: warehouse.id, invoiceNumber, items: [{ inventoryItemId: item.id, quantity: 5, unitCost: 10 }] }), tenant.userId, transaction);
    assert.equal(receipt.status, 'DRAFT');
    assert.equal(await InventoryMovement.count({ where: { inventoryItemId: item.id }, transaction }), 0, 'NF lançada sem conferência/confirmação não move estoque');
    assert.equal(await InventoryStockBalance.count({ where: { inventoryItemId: item.id }, transaction }), 0);
    assert.equal(await FinancialEntry.count({ where: { description: { [Op.like]: `%${invoiceNumber}%` } }, transaction }), 0, 'e não cria contas a pagar');
  });
});

test('Controle positivo: a mesma NF COM recebimento gera exatamente 1 payable do valor da nota', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { order, warehouse, poItem } = await buildOpenOrder(transaction);
    const { goodsReceipt } = await procurementService.confirmGoodsReceipt(order.id, tenant.groupId, tenant.companyId,
      { destinationLocationId: warehouse.id, invoiceFingerprint: `NF-${uniqueSuffix()}`, invoiceTotalAmount: 400, items: [{ purchaseOrderItemId: poItem.id, receivedQuantity: 10 }] }, actor(), transaction);
    assert.deepEqual(await traces(order.id, transaction), { receipts: 1, payables: 1 });
    const payable = await FinancialEntry.findByPk(goodsReceipt.financialEntryId, { transaction });
    assert.equal(payable.nature, 'PAYABLE');
    assert.equal(Number(payable.amount), 400);
  });
});

test('T-invoice sem receipt (rota): POST goods-receipts só com a NF → 400 e nada gravado; não existe rota de NF avulsa', async () => {
  const fx = await withTenantTransaction(tenant, (transaction) => buildOpenOrder(transaction));
  created.personIds.push(fx.supplier.id);
  created.requestIds.push(fx.request.id);
  created.orderIds.push(fx.order.id);
  created.itemIds.push(fx.item.id);
  created.locationIds.push(fx.warehouse.id);
  const call = (method, path, body) => fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });

  const invoiceOnly = { destinationLocationId: fx.warehouse.id, invoiceFingerprint: `NF-${uniqueSuffix()}`, invoiceTotalAmount: 400 };
  for (const body of [invoiceOnly, { ...invoiceOnly, items: [] }]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call('POST', `/procurement/purchase-orders/${fx.order.id}/goods-receipts`, body);
    assert.equal(res.status, 400);
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await res.json()).error.code, 'GOODS_RECEIPT_VALIDATION');
  }

  const list = await call('GET', `/procurement/purchase-orders/${fx.order.id}/goods-receipts`);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).data, [], 'nenhum recebimento ficou registrado pela rota');
  const order = await call('GET', `/procurement/purchase-orders/${fx.order.id}`);
  assert.equal((await order.json()).data.status, 'OPEN', 'o pedido continua em aberto, sem recebimento');
  assert.deepEqual(await withTenantTransaction(tenant, (t) => traces(fx.order.id, t)), { receipts: 0, payables: 0 });

  for (const path of ['/procurement/invoices', `/procurement/purchase-orders/${fx.order.id}/invoices`, `/procurement/purchase-orders/${fx.order.id}/payables`]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call('POST', path, invoiceOnly);
    assert.equal(res.status, 404, `${path} não pode existir`);
  }
});
