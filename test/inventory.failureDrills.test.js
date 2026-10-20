'use strict';

/**
 * Failure drills de Estoque/Compras (Marco 7, Guia §1/§14 "testes/carga/falhas").
 *
 * Mesmo padrão de construction.failureDrills.test.js: cada drill força uma falha de verdade NO
 * MEIO de uma operação de negócio real, em transação COMMITADA (conexão própria, com o SET LOCAL
 * do tenant), e prova que o rollback é completo — nada fica pela metade — e que o retry é
 * idempotente (repetir a mesma operação não duplica nada).
 *
 *   Drill 1 — recebimento de compra: a gravação do payable cai depois de o recebimento, o recibo
 *     de estoque, o movimento IN e o saldo já terem sido escritos na transação. Depois da falha:
 *     nenhum recebimento, nenhum movimento, saldo e quantidade recebida do pedido intactos.
 *     Retry com a mesma idempotencyKey: 1 recebimento, 1 payable, saldo +N uma única vez; um
 *     segundo retry (replay) devolve o MESMO recebimento.
 *   Drill 2 — transferência: a escrita da 2ª perna (saldo de destino) cai depois de a 1ª perna
 *     (saída da origem) já ter sido aplicada. Nenhum movimento; origem e destino intactos.
 *     Retry com a mesma idempotencyKey aplica uma vez; replay não duplica.
 *   Drill 3 — entrega de requisição com 2 linhas: a 2ª linha falha. A requisição continua
 *     APPROVED, nenhuma saída, saldos intactos. Retry entrega tudo; nova entrega é recusada
 *     (INVALID_TRANSITION) sem duplicar saída.
 *
 * Como estes drills COMMITAM dados, só rodam em banco descartável (scripts/withDisposableDb.js
 * define DISPOSABLE_DB=1) ou no CI (Postgres efêmero do job) — nunca no banco compartilhado.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const canRun = Boolean(process.env.DISPOSABLE_DB || process.env.CI);
const skip = canRun ? false : 'commita dados: rode com scripts/withDisposableDb.js (ou no CI)';

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const fx = require('../scripts/lib/inventoryFixtures');
const { FinancialEntry, GoodsReceipt, InventoryMovement, InventoryStockBalance, InventoryReceipt, PurchaseOrderItem, InventoryRequisition, User } = require('../src/models');

let tenant;
let ctx;
let approver;

before(async () => {
  if (!canRun) return;
  tenant = await getSeedTenant();
  ctx = fx.load();
  approver = await User.create({ name: `Drill falha aprovador ${uniqueSuffix()}`, email: `drill-falha-${uniqueSuffix()}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' });
});

after(async () => {
  await sequelize.close();
});

const T = (fn, userId) => fx.inTenant(ctx, tenant, fn, userId);
const balanceOf = (itemId, locationId) => T(async (t) => {
  const b = await InventoryStockBalance.findOne({ where: { inventoryItemId: itemId, locationId }, transaction: t });
  return b ? Number(b.quantityOnHand) : 0;
});

/** Substitui temporariamente model.method; `shouldFail(callIndex, args)` decide quando lançar. */
function injectFailure(model, method, shouldFail, message) {
  const original = model[method];
  let calls = 0;
  model[method] = async function patched(...args) {
    calls += 1;
    if (shouldFail(calls, args)) {
      const err = new Error(message);
      err.code = 'DRILL_INJECTED_FAILURE';
      throw err;
    }
    return original.apply(this, args);
  };
  return () => { model[method] = original; };
}

test('Drill 1: falha ao gravar o payable no meio do recebimento não deixa estado parcial; retry idempotente', { skip }, async () => {
  const base = await T(async (t) => {
    const item = await fx.createItem(ctx, tenant, t, `Drill falha receb ${uniqueSuffix()}`);
    const wh = await fx.createWarehouse(ctx, tenant, t, `Drill falha dep ${uniqueSuffix()}`);
    const supplier = await fx.createPerson(ctx, tenant, t, `Drill falha fornecedor ${uniqueSuffix()}`);
    const po = await fx.createOpenPurchaseOrder(ctx, tenant, t, { supplierPersonId: supplier.id, approverId: approver.id, lines: [{ inventoryItemId: item.id, description: 'Areia', quantity: 30, unitPrice: 12.5 }] });
    return { item, wh, po };
  });
  const payload = { destinationLocationId: base.wh.id, invoiceFingerprint: `DRILL-F1-${uniqueSuffix()}`, invoiceTotalAmount: 250, idempotencyKey: `drill-f1-${uniqueSuffix()}`, items: [{ purchaseOrderItemId: base.po.items[0].id, receivedQuantity: 20 }] };
  const receive = () => T((t) => ctx.procurementService.confirmGoodsReceipt(base.po.order.id, tenant.groupId, tenant.companyId, payload, { userId: tenant.userId, canApprove: false }, t));
  const state = () => T(async (t) => ({
    receipts: await GoodsReceipt.count({ where: { purchaseOrderId: base.po.order.id }, transaction: t }),
    movements: await InventoryMovement.count({ where: { inventoryItemId: base.item.id }, transaction: t }),
    inventoryReceipts: await InventoryReceipt.count({ where: { destinationLocationId: base.wh.id }, transaction: t }),
    received: Number((await PurchaseOrderItem.findByPk(base.po.items[0].id, { transaction: t })).receivedQuantity),
    payables: await FinancialEntry.count({ where: { idempotencyKey: (await GoodsReceipt.findAll({ where: { purchaseOrderId: base.po.order.id }, transaction: t })).map((g) => `goods-receipt:${g.id}`) }, transaction: t }),
  }));

  const restore = injectFailure(FinancialEntry, 'create', () => true, 'conexão com o Financeiro caiu (drill)');
  try {
    await assert.rejects(receive(), (err) => err.code === 'DRILL_INJECTED_FAILURE' || /drill/.test(err.message));
  } finally {
    restore();
  }
  assert.deepEqual(await state(), { receipts: 0, movements: 0, inventoryReceipts: 0, received: 0, payables: 0 }, 'falha no meio = rollback total');
  assert.equal(await balanceOf(base.item.id, base.wh.id), 0);

  const first = await receive();
  const replay = await receive();
  assert.equal(replay.goodsReceipt.id, first.goodsReceipt.id, 'replay devolve o mesmo recebimento');
  assert.deepEqual(await state(), { receipts: 1, movements: 1, inventoryReceipts: 1, received: 20, payables: 1 });
  assert.equal(await balanceOf(base.item.id, base.wh.id), 20, 'saldo entrou uma única vez');
});

test('Drill 2: falha na 2ª perna da transferência não deixa saída sem entrada; retry idempotente', { skip }, async () => {
  const base = await T(async (t) => {
    const item = await fx.createItem(ctx, tenant, t, `Drill falha transf ${uniqueSuffix()}`);
    const origem = await fx.createWarehouse(ctx, tenant, t, `Drill origem ${uniqueSuffix()}`);
    const destino = await fx.createWarehouse(ctx, tenant, t, `Drill destino ${uniqueSuffix()}`);
    const resp = await fx.createPerson(ctx, tenant, t, `Drill resp ${uniqueSuffix()}`, 'PF');
    await fx.move(ctx, tenant, t, { inventoryItemId: item.id, movementType: 'IN', quantity: 50, destinationLocationId: origem.id, reason: 'saldo inicial' });
    return { item, origem, destino, resp };
  });
  const key = `drill-f2-${uniqueSuffix()}`;
  const transfer = () => T((t) => fx.move(ctx, tenant, t, { inventoryItemId: base.item.id, movementType: 'TRANSFER', quantity: 15, sourceLocationId: base.origem.id, destinationLocationId: base.destino.id, responsiblePersonId: base.resp.id, idempotencyKey: key, reason: 'drill' }));

  // applyBalanceDelta lê o saldo com FOR UPDATE: 1ª leitura = origem (já debitada), 2ª = destino.
  const restore = injectFailure(InventoryStockBalance, 'findOne', (n, args) => n === 2 && args[0]?.lock, 'queda de conexão na 2ª perna (drill)');
  try {
    await assert.rejects(transfer(), (err) => err.code === 'DRILL_INJECTED_FAILURE');
  } finally {
    restore();
  }
  assert.equal(await balanceOf(base.item.id, base.origem.id), 50, 'origem não foi debitada');
  assert.equal(await balanceOf(base.item.id, base.destino.id), 0);
  assert.equal(await T((t) => InventoryMovement.count({ where: { idempotencyKey: key }, transaction: t })), 0, 'nenhum movimento ficou gravado');

  const first = await transfer();
  const replay = await transfer();
  assert.equal(replay.id, first.id, 'replay com a mesma chave devolve o mesmo movimento');
  assert.equal(await balanceOf(base.item.id, base.origem.id), 35);
  assert.equal(await balanceOf(base.item.id, base.destino.id), 15);
});

test('Drill 3: falha na 2ª linha da entrega de requisição não entrega nada; retry entrega uma vez', { skip }, async () => {
  const base = await T(async (t) => {
    const a = await fx.createItem(ctx, tenant, t, `Drill req A ${uniqueSuffix()}`);
    const b = await fx.createItem(ctx, tenant, t, `Drill req B ${uniqueSuffix()}`);
    const wh = await fx.createWarehouse(ctx, tenant, t, `Drill req dep ${uniqueSuffix()}`);
    await fx.move(ctx, tenant, t, { inventoryItemId: a.id, movementType: 'IN', quantity: 10, destinationLocationId: wh.id, reason: 'saldo inicial' });
    await fx.move(ctx, tenant, t, { inventoryItemId: b.id, movementType: 'IN', quantity: 10, destinationLocationId: wh.id, reason: 'saldo inicial' });
    const responsible = await fx.createPerson(ctx, tenant, t, `Drill req resp ${uniqueSuffix()}`);
    const req = await ctx.requisitionsService.createRequisition({ groupId: tenant.groupId, companyId: tenant.companyId, warehouseLocationId: wh.id, items: [{ inventoryItemId: a.id, quantity: 4 }, { inventoryItemId: b.id, quantity: 6 }] }, tenant.userId, t);
    return { a, b, wh, req, responsible };
  });
  await T((t) => ctx.requisitionsService.decideRequisition(base.req.id, 'APPROVED', approver.id, tenant.groupId, tenant.companyId, t), approver.id);
  const issue = () => T((t) => ctx.requisitionsService.issueRequisition(base.req.id, { userId: tenant.userId, canApprove: true }, tenant.groupId, tenant.companyId, t, { responsiblePersonId: base.responsible.id }));
  const outs = () => T((t) => InventoryMovement.count({ where: { sourceId: base.req.id, movementType: 'OUT' }, transaction: t }));

  const restore = injectFailure(InventoryMovement, 'create', (n) => n === 2, 'falha ao gravar a 2ª saída (drill)');
  try {
    await assert.rejects(issue(), (err) => err.code === 'DRILL_INJECTED_FAILURE');
  } finally {
    restore();
  }
  assert.equal((await T((t) => InventoryRequisition.findByPk(base.req.id, { transaction: t }))).status, 'APPROVED');
  assert.equal(await outs(), 0, 'nenhuma saída parcial');
  assert.equal(await balanceOf(base.a.id, base.wh.id), 10);
  assert.equal(await balanceOf(base.b.id, base.wh.id), 10);

  await issue();
  await assert.rejects(issue(), (err) => err.code === 'INVENTORY_REQUISITION_INVALID_TRANSITION');
  assert.equal(await outs(), 2);
  assert.equal(await balanceOf(base.a.id, base.wh.id), 6);
  assert.equal(await balanceOf(base.b.id, base.wh.id), 4);
});
