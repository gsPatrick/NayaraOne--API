'use strict';

// Revisão independente do Marco 7 (19/10/2026) — B1/B2/B4/B12 sob concorrência REAL (duas
// conexões). Os dados precisam estar commitados para uma transação enxergar a outra, por isso
// este arquivo SÓ roda em banco descartável:
//   node scripts/withDisposableDb.js -- node --test --test-concurrency=1 test/marco7rev19.B.concurrency.test.js
// Fora de banco descartável (DISPOSABLE_DB=1 ou CI, cujo Postgres é efêmero) os testes são pulados.
//
// Sincronização sem sorte de timing: a transação A faz a operação e NÃO commita; a B é disparada
// e fica parada no lock; só então A commita. Assim a B obrigatoriamente roda "depois" e precisa
// reler o estado confirmado por A.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const { createQualifiedSupplier } = require('./procurementTestSupplier');
const procurementService = require('../src/features/procurement/procurement.service');
const itemsService = require('../src/features/inventory/items.service');
const { User, FinancialEntry, ReceiptDiscrepancy } = require('../src/models');

const DISPOSABLE = Boolean(process.env.DISPOSABLE_DB || process.env.CI);
let tenant;

before(async () => {
  if (DISPOSABLE) tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function openTx() {
  const t = await sequelize.transaction();
  await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
  await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
  return t;
}

async function committed(fn) {
  const t = await openTx();
  try {
    const r = await fn(t);
    await t.commit();
    return r;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

const withTenant = (f) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...f });

// Pedido 25×R$4 recebido com 30 unidades e NF de R$150: abre OVER_RECEIPT e PRICE_MISMATCH.
async function fixture() {
  return committed(async (t) => {
    const suffix = uniqueSuffix();
    const item = await itemsService.createItem(withTenant({ name: `REV19C ${suffix}`, sku: `REV19C-${suffix}`, unitOfMeasure: 'UN' }), tenant.userId, t);
    const location = await itemsService.createLocation(withTenant({ name: `REV19C dep ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, t);
    const { supplierPersonId } = await createQualifiedSupplier(tenant, t);
    const request = await procurementService.createPurchaseRequest(withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 25 }] }), tenant.userId, t);
    const mk = (label) => User.create({ name: `REV19C ${label} ${suffix}`, email: `rev19c-${label}-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' }, { transaction: t });
    const approver = await mk('apr');
    const resolverA = await mk('ra');
    const resolverB = await mk('rb');
    await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', approver.id, t);
    const quotation = await procurementService.createQuotation(request.id, tenant.groupId, tenant.companyId, tenant.userId, t);
    const offer = await procurementService.submitSupplierOffer(quotation.id, tenant.groupId, tenant.companyId, { supplierPersonId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 4 }] }, t);
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.groupId, tenant.companyId, tenant.userId, t);
    const { goodsReceipt, discrepancies } = await procurementService.confirmGoodsReceipt(
      order.id, tenant.groupId, tenant.companyId,
      { destinationLocationId: location.id, invoiceFingerprint: `NF-C-${suffix}`, invoiceTotalAmount: 150, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 30 }] },
      { userId: tenant.userId, canApprove: true }, t
    );
    return {
      order, goodsReceipt, resolverA, resolverB,
      over: discrepancies.find((d) => d.discrepancyType === 'OVER_RECEIPT'),
      price: discrepancies.find((d) => d.discrepancyType === 'PRICE_MISMATCH'),
    };
  });
}

async function activePayables(goodsReceiptId) {
  return committed(async (t) => {
    const entries = await FinancialEntry.findAll({
      where: { idempotencyKey: { [Op.like]: `goods-receipt:${goodsReceiptId}%` }, nature: 'PAYABLE', status: { [Op.notIn]: ['REVERSED', 'CANCELLED'] } },
      transaction: t,
    });
    return { entries, total: Math.round(entries.reduce((a, e) => a + Number(e.amount), 0) * 100) / 100 };
  });
}

const accept = (id, userId, t) => procurementService.resolveDiscrepancy(id, tenant.groupId, tenant.companyId, { resolution: 'ACCEPTED', notes: 'ok' }, { userId }, t);

test('B1/B2 concorrência: duas pessoas decidem as duas divergências do MESMO recebimento ao mesmo tempo → um único payable de R$150, liberado', { skip: !DISPOSABLE && 'só em banco descartável (scripts/withDisposableDb.js)' }, async () => {
  const fx = await fixture();
  const tA = await openTx();
  const tB = await openTx();
  try {
    await accept(fx.over.id, fx.resolverA.id, tA); // A decide e segura o commit
    const pendingB = accept(fx.price.id, fx.resolverB.id, tB); // B fica parada no lock do recebimento
    await new Promise((r) => setTimeout(r, 300));
    await tA.commit();
    await pendingB;
    await tB.commit();
  } catch (err) {
    await tA.rollback().catch(() => {});
    await tB.rollback().catch(() => {});
    throw err;
  }
  const { entries, total } = await activePayables(fx.goodsReceipt.id);
  assert.equal(total, 150, 'pedido R$100 + excedente aceito R$20 + diferença de preço aceita R$30 — uma vez só');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].requiresManualReview, false, 'decididas as duas divergências, o payable é liberado');
});

test('B4/B12 concorrência: cancelar o pedido enquanto alguém decide a divergência → a decisão perde (divergência já encerrada) e nada fica a pagar', { skip: !DISPOSABLE && 'só em banco descartável (scripts/withDisposableDb.js)' }, async () => {
  const fx = await fixture();
  const tA = await openTx();
  const tB = await openTx();
  let errB = null;
  try {
    await procurementService.cancelPurchaseOrder(fx.order.id, tenant.groupId, tenant.companyId, { reason: 'concorrência' }, { userId: fx.resolverA.id }, tA);
    const pendingB = accept(fx.over.id, fx.resolverB.id, tB).catch((e) => { errB = e; });
    await new Promise((r) => setTimeout(r, 300));
    await tA.commit();
    await pendingB;
    await tB.rollback();
  } catch (err) {
    await tA.rollback().catch(() => {});
    await tB.rollback().catch(() => {});
    throw err;
  }
  assert.ok(errB, 'a decisão concorrente precisa ser recusada');
  assert.equal(errB.code, 'RECEIPT_DISCREPANCY_INVALID_STATUS', `recusa por estado, nunca deadlock (veio ${errB.code || errB.parent?.code})`);
  const { total } = await activePayables(fx.goodsReceipt.id);
  assert.equal(total, 0);
  const over = await committed((t) => ReceiptDiscrepancy.findByPk(fx.over.id, { transaction: t }));
  assert.equal(over.status, 'CANCELED');
});
