'use strict';

// Revisão independente do Marco 7 (19/10/2026) — seção B, Compras (B1–B4, B9–B13).
// Banco real (Postgres, RLS ativo), tudo dentro de withRollbackTenantTransaction: nada fica
// gravado no banco compartilhado.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { createQualifiedSupplier, farFutureDateOnly } = require('./procurementTestSupplier');
const procurementService = require('../src/features/procurement/procurement.service');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const financeAntifraud = require('../src/features/finance/financeAntifraud.service');
const {
  User, Person, PurchaseRequest, PurchaseOrderItem, FinancialEntry, ReceiptDiscrepancy, SupplierEvaluation, SupplierQualification,
} = require('../src/models');

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

async function newUser(transaction, label) {
  const suffix = uniqueSuffix();
  return User.create(
    { name: `QA REV19 ${label} ${suffix}`, email: `qa-rev19-${label}-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
    { transaction }
  );
}

async function createItemAndWarehouse(transaction) {
  const suffix = uniqueSuffix();
  const item = await itemsService.createItem(
    withTenant({ name: `REV19 Item ${suffix}`, sku: `SKU-REV19-${suffix}`, unitOfMeasure: 'UN' }),
    tenant.userId,
    transaction
  );
  const location = await itemsService.createLocation(
    withTenant({ name: `REV19 Deposito ${suffix}`, locationType: 'WAREHOUSE' }),
    tenant.userId,
    transaction
  );
  return { item, location };
}

async function cycle(transaction, { item, quantity = 25, unitPrice = 4, supplierPersonId }) {
  const supplierId = supplierPersonId || (await createQualifiedSupplier(tenant, transaction)).supplierPersonId;
  const request = await procurementService.createPurchaseRequest(
    withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity }] }),
    tenant.userId,
    transaction
  );
  const approver = await newUser(transaction, 'aprovador');
  await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', approver.id, transaction);
  const quotation = await procurementService.createQuotation(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  const offer = await procurementService.submitSupplierOffer(
    quotation.id, tenant.groupId, tenant.companyId,
    { supplierPersonId: supplierId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice }] },
    transaction
  );
  const order = await procurementService.awardSupplierOffer(offer.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  return { request, order, supplierPersonId: supplierId };
}

function receive(transaction, order, location, quantity, extra = {}) {
  return procurementService.confirmGoodsReceipt(
    order.id, tenant.groupId, tenant.companyId,
    { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: quantity }], ...extra },
    { userId: tenant.userId, canApprove: true },
    transaction
  );
}

// Soma dos contas a pagar ATIVOS (não estornados/cancelados) gerados por um recebimento.
async function activePayablesOf(goodsReceiptId, transaction) {
  const entries = await FinancialEntry.findAll({
    where: {
      idempotencyKey: { [Op.like]: `goods-receipt:${goodsReceiptId}%` },
      nature: 'PAYABLE',
      status: { [Op.notIn]: ['REVERSED', 'CANCELLED'] },
    },
    transaction,
  });
  return { entries, total: Math.round(entries.reduce((acc, e) => acc + Number(e.amount), 0) * 100) / 100 };
}

async function balanceOf(itemId, locationId, transaction) {
  const balance = await movementsService.getBalance(itemId, locationId, tenant.groupId, tenant.companyId, transaction);
  return Number(balance?.quantity ?? balance ?? 0);
}

async function resolveAll(goodsReceiptDiscrepancies, resolution, resolverId, transaction) {
  for (const d of goodsReceiptDiscrepancies) {
     
    await procurementService.resolveDiscrepancy(
      d.id, tenant.groupId, tenant.companyId,
      { resolution, notes: resolution === 'REJECTED' ? 'Não confere com o pedido.' : 'Conferido.' },
      { userId: resolverId }, transaction
    );
  }
}

// ---------------------------------------------------------------------------------------------
// B1 — excedente com NF pago duas vezes
// ---------------------------------------------------------------------------------------------
test('B1: PO 25×R$4, recebe 30 com NF de R$120 e o excedente é aceito → total a pagar é R$120, nunca R$140', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order } = await cycle(transaction, { item });
    const { goodsReceipt, discrepancies } = await receive(transaction, order, location, 30, { invoiceFingerprint: `NF-B1-${uniqueSuffix()}`, invoiceTotalAmount: 120 });
    const resolver = await newUser(transaction, 'resolvedor');
    await resolveAll(discrepancies, 'ACCEPTED', resolver.id, transaction);

    const { total } = await activePayablesOf(goodsReceipt.id, transaction);
    assert.equal(total, 120, 'a NF cobra 30 unidades (R$120); o excedente aceito não pode gerar um segundo pagamento');
  });
});

// ---------------------------------------------------------------------------------------------
// B2 — divergência aberta não segura o pagamento
// ---------------------------------------------------------------------------------------------
test('B2: NF de R$150 para um pedido de R$100 → enquanto a divergência está aberta, o payable fica no valor do pedido e RETIDO', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order } = await cycle(transaction, { item });
    const { goodsReceipt, discrepancies } = await receive(transaction, order, location, 25, { invoiceFingerprint: `NF-B2-${uniqueSuffix()}`, invoiceTotalAmount: 150 });
    assert.ok(discrepancies.some((d) => d.discrepancyType === 'PRICE_MISMATCH'));

    const { entries, total } = await activePayablesOf(goodsReceipt.id, transaction);
    assert.equal(total, 100, 'com a divergência aberta, o valor a pagar é o do pedido (R$100), nunca o contestado (R$150)');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].requiresManualReview, true, 'o payable precisa nascer retido até a decisão da divergência');

    // O Financeiro não consegue liberar por fora enquanto a divergência está aberta.
    await assert.rejects(
      () => financeAntifraud.clearManualReview(entries[0].id, tenant.userId, transaction, 'tentando liberar'),
      (err) => err.code === 'PROCUREMENT_RECEIPT_DISCREPANCY_OPEN'
    );
  });
});

test('B2: aceitar a divergência de preço → payable vira R$150 e é liberado; rejeitar → R$100 liberado', async () => {
  for (const [resolution, expected] of [['ACCEPTED', 150], ['REJECTED', 100]]) {
     
    await withRollbackTenantTransaction(tenant, async (transaction) => {
      const { item, location } = await createItemAndWarehouse(transaction);
      const { order } = await cycle(transaction, { item });
      const { goodsReceipt, discrepancies } = await receive(transaction, order, location, 25, { invoiceFingerprint: `NF-B2b-${uniqueSuffix()}`, invoiceTotalAmount: 150 });
      const resolver = await newUser(transaction, 'resolvedor');
      await resolveAll(discrepancies, resolution, resolver.id, transaction);
      const { entries, total } = await activePayablesOf(goodsReceipt.id, transaction);
      assert.equal(total, expected, `${resolution}: total a pagar`);
      assert.ok(entries.every((e) => e.requiresManualReview === false), `${resolution}: payable liberado após a decisão`);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// B3 — cancelar depois de rejeitar o excedente
// ---------------------------------------------------------------------------------------------
test('B3: excedente rejeitado não conta como recebido no pedido; cancelar estorna só o que entrou no estoque', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order } = await cycle(transaction, { item });
    const { discrepancies } = await receive(transaction, order, location, 30);
    const poItemAfterReceipt = await PurchaseOrderItem.findByPk(order.items[0].id, { transaction });
    assert.equal(Number(poItemAfterReceipt.receivedQuantity), 25, 'o excedente ainda não decidido não entra no recebido do pedido');

    const resolver = await newUser(transaction, 'resolvedor');
    await resolveAll(discrepancies, 'REJECTED', resolver.id, transaction);
    assert.equal(await balanceOf(item.id, location.id, transaction), 25);

    await procurementService.cancelPurchaseOrder(order.id, tenant.groupId, tenant.companyId, { reason: 'B3' }, { userId: resolver.id }, transaction);
    assert.equal(await balanceOf(item.id, location.id, transaction), 0, 'o estorno é de 25 (o que entrou), não de 30');
  });
});

// M7-F05 (conferência da cliente, 20/10/2026): cancelamento reverte o INCORPORADO (25), nunca o
// recebido físico integral (30), com o excedente ainda ABERTO.
test('M7-F05: cancelar com o excedente ainda OPEN estorna 25 (incorporado), não 30, e o saldo não fica negativo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order } = await cycle(transaction, { item });
    const { discrepancies } = await receive(transaction, order, location, 30);
    assert.equal(discrepancies.every((d) => d.status === 'OPEN'), true);
    assert.equal(await balanceOf(item.id, location.id, transaction), 25, 'só o pedido (25) entra no estoque; o excedente fica em espera');
    const canceller = await newUser(transaction, 'cancelador-f05');
    await procurementService.cancelPurchaseOrder(order.id, tenant.groupId, tenant.companyId, { reason: 'F05 aberto' }, { userId: canceller.id }, transaction);
    assert.equal(await balanceOf(item.id, location.id, transaction), 0, 'estorno de 25; nunca -5');
  });
});

// ---------------------------------------------------------------------------------------------
// B4 — cancelar não estorna o payable do excedente aceito
// ---------------------------------------------------------------------------------------------
test('B4: cancelar o pedido estorna TODOS os payables do recebimento, inclusive o do excedente aceito', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order } = await cycle(transaction, { item });
    const { goodsReceipt, discrepancies } = await receive(transaction, order, location, 30);
    const resolver = await newUser(transaction, 'resolvedor');
    await resolveAll(discrepancies, 'ACCEPTED', resolver.id, transaction);
    assert.equal((await activePayablesOf(goodsReceipt.id, transaction)).total, 120);

    await procurementService.cancelPurchaseOrder(order.id, tenant.groupId, tenant.companyId, { reason: 'B4' }, { userId: resolver.id }, transaction);
    assert.equal((await activePayablesOf(goodsReceipt.id, transaction)).total, 0, 'nada pode ficar a pagar de um pedido cancelado');
    assert.equal(await balanceOf(item.id, location.id, transaction), 0, 'estoque estornado inclusive do excedente aceito');
  });
});

// ---------------------------------------------------------------------------------------------
// B12 — cancelar fecha divergências abertas e reverte a requisição DELIVERED
// ---------------------------------------------------------------------------------------------
test('B12: cancelar o pedido fecha as divergências abertas e tira a requisição de DELIVERED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order, request } = await cycle(transaction, { item });
    const { discrepancies } = await receive(transaction, order, location, 30);
    const reqBefore = await PurchaseRequest.findByPk(request.id, { transaction });
    assert.equal(reqBefore.status, 'DELIVERED');

    const canceller = await newUser(transaction, 'cancelador');
    await procurementService.cancelPurchaseOrder(order.id, tenant.groupId, tenant.companyId, { reason: 'B12' }, { userId: canceller.id }, transaction);

    const over = await ReceiptDiscrepancy.findByPk(discrepancies[0].id, { transaction });
    assert.equal(over.status, 'CANCELED', 'divergência aberta do pedido cancelado é encerrada');
    const reqAfter = await PurchaseRequest.findByPk(request.id, { transaction });
    assert.notEqual(reqAfter.status, 'DELIVERED', 'requisição de pedido cancelado não pode continuar "Entregue"');
    assert.equal(reqAfter.status, 'CLOSED');
  });
});

// ---------------------------------------------------------------------------------------------
// B9 — segregação na qualificação
// ---------------------------------------------------------------------------------------------
test('B9: quem só cadastra (sem procurement:approve) e estende a vigência de uma due diligence aprovada a devolve para PENDING', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { supplierPersonId, qualification } = await createQualifiedSupplier(tenant, transaction, { highRisk: true });
    const approver = await newUser(transaction, 'dd');
    await procurementService.decideSupplierDueDiligence(qualification.id, tenant.groupId, tenant.companyId, { decision: 'APPROVED' }, { userId: approver.id }, transaction);

    const updated = await procurementService.upsertSupplierQualification(
      withTenant({ supplierPersonId, highRisk: true, validUntil: farFutureDateOnly(9) }),
      tenant.userId,
      { canApprove: false },
      transaction
    );
    assert.equal(updated.dueDiligenceStatus, 'PENDING', 'nova vigência/documentos exigem nova decisão de quem aprova');
  });
});

test('B9: quem cadastrou a qualificação não decide a própria due diligence', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { qualification } = await createQualifiedSupplier(tenant, transaction, { highRisk: true });
    await assert.rejects(
      () => procurementService.decideSupplierDueDiligence(qualification.id, tenant.groupId, tenant.companyId, { decision: 'APPROVED' }, { userId: tenant.userId }, transaction),
      (err) => err.code === 'SUPPLIER_DUE_DILIGENCE_SELF_DECISION_BLOCKED'
    );
  });
});

// ---------------------------------------------------------------------------------------------
// B10 — fornecedor sem qualificação não é adjudicado
// ---------------------------------------------------------------------------------------------
test('B10: fornecedor sem qualificação (ou sem documento / vigência vencida) não recebe pedido', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item } = await createItemAndWarehouse(transaction);
    const bare = await Person.create(withTenant({ personType: 'PJ', legalName: `REV19 sem qualificação ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId }), { transaction });
    await assert.rejects(() => cycle(transaction, { item, supplierPersonId: bare.id }), (err) => err.code === 'SUPPLIER_QUALIFICATION_REQUIRED');

    const { supplierPersonId, qualification } = await createQualifiedSupplier(tenant, transaction);
    await SupplierQualification.update({ validUntil: '2020-01-01' }, { where: { id: qualification.id }, transaction });
    await assert.rejects(() => cycle(transaction, { item, supplierPersonId }), (err) => err.code === 'SUPPLIER_QUALIFICATION_REQUIRED');

    await SupplierQualification.update({ validUntil: farFutureDateOnly(), documentFileIds: [] }, { where: { id: qualification.id }, transaction });
    await assert.rejects(() => cycle(transaction, { item, supplierPersonId }), (err) => err.code === 'SUPPLIER_QUALIFICATION_REQUIRED');
  });
});

// ---------------------------------------------------------------------------------------------
// B11 — NF duplicada é por fornecedor
// ---------------------------------------------------------------------------------------------
test('B11: a mesma numeração de NF de fornecedores diferentes é aceita; repetida do mesmo fornecedor é bloqueada (409)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const nf = `NF-B11-${uniqueSuffix()}`;
    const a = await cycle(transaction, { item, quantity: 5 });
    const b = await cycle(transaction, { item, quantity: 5 });
    await receive(transaction, a.order, location, 2, { invoiceFingerprint: nf });
    await receive(transaction, b.order, location, 2, { invoiceFingerprint: nf });

    await assert.rejects(
      () => receive(transaction, a.order, location, 1, { invoiceFingerprint: nf }),
      (err) => err.code === 'GOODS_RECEIPT_DUPLICATE_INVOICE' && err.statusCode === 409
    );
  });
});

// ---------------------------------------------------------------------------------------------
// B13 — listagens com filtro de empresa no where
// ---------------------------------------------------------------------------------------------
test('B13: listSupplierEvaluations e listPolicyInstallments filtram por empresa no where (defesa em profundidade)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { supplierPersonId } = await createQualifiedSupplier(tenant, transaction);
    await SupplierEvaluation.create(withTenant({ supplierPersonId, score: 4, createdBy: tenant.userId }), { transaction });
    const otherCompanyId = '00000000-0000-4000-8000-000000000000';
    const own = await procurementService.listSupplierEvaluations(tenant.groupId, tenant.companyId, transaction, { supplierPersonId });
    assert.equal(own.count, 1);
    const foreign = await procurementService.listSupplierEvaluations(tenant.groupId, otherCompanyId, transaction, { supplierPersonId });
    assert.equal(foreign.count, 0, 'empresa diferente no filtro não pode devolver linhas, mesmo que o RLS deixasse');

    const insuranceService = require('../src/features/procurement/insurance.service');
    const policy = await insuranceService.createPolicy(withTenant({ coverageSummary: 'B13' }), tenant.userId, transaction);
    const { InsuranceInstallment } = require('../src/models');
    await InsuranceInstallment.create(withTenant({ policyId: policy.id, dueDate: '2031-01-10', amount: 10, status: 'PENDING' }), { transaction });
    const ownInst = await insuranceService.listPolicyInstallments(policy.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(ownInst.length, 1);
    const foreignInst = await insuranceService.listPolicyInstallments(policy.id, tenant.groupId, otherCompanyId, transaction);
    assert.equal(foreignInst.length, 0);
  });
});
