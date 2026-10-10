'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const procurementService = require('../src/features/procurement/procurement.service');
const insuranceService = require('../src/features/procurement/insurance.service');
const { Person, FinancialEntry, User } = require('../src/models');

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

function actorWithTenant(extra) {
  return { userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, ...extra };
}

async function createItemAndWarehouse(transaction, extra = {}) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const item = await itemsService.createItem(
    withTenant({ name: `AUDIT GAP2 Item ${suffix}`, sku: `SKU-AG2-${suffix}`, unitOfMeasure: 'UN', ...extra }),
    tenant.userId,
    transaction
  );
  const location = await itemsService.createLocation(
    withTenant({ name: `AUDIT GAP2 Deposito ${Date.now()}${Math.floor(Math.random() * 10000)}`, locationType: 'WAREHOUSE' }),
    tenant.userId,
    transaction
  );
  return { item, location };
}

async function fullProcurementCycle(transaction, { item, quantity = 10, unitPrice = 3 }) {
  const request = await procurementService.createPurchaseRequest(
    withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity }] }),
    tenant.userId,
    transaction
  );
  // GAP REAL CORRIGIDO (segregação "quem cria não aprova", 2026-10-08): decidePurchaseRequest
  // agora rejeita quando o ator é o mesmo que criou a requisição — segundo usuário criado dentro
  // da própria transação (rollback no fim do teste, mesmo padrão de marco4.acceptance.batch2).
  const secondApproverSuffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const secondApprover = await User.create(
    { name: `QA AUDIT GAP2 segundo aprovador ${secondApproverSuffix}`, email: `qa-auditgap2-approver-${secondApproverSuffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
    { transaction }
  );
  await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', secondApprover.id, transaction);
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

// Item 1 — due diligence bypass: highRisk:false não pode "desligar" silenciosamente uma
// qualification já REJECTED sem a mesma alçada (procurement:approve) usada para decidir.
test('upsertSupplierQualification: rebaixar highRisk de uma qualification REJECTED exige canApprove', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const supplier = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PJ', legalName: `Fornecedor Audit Gap2 ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );

    const qualification = await procurementService.upsertSupplierQualification(
      withTenant({ supplierPersonId: supplier.id, highRisk: true }),
      tenant.userId,
      { canApprove: true },
      transaction
    );
    await procurementService.decideSupplierDueDiligence(
      qualification.id, tenant.groupId, tenant.companyId, { decision: 'REJECTED' }, actorOf(), transaction
    );

    // Sem procurement:approve, não pode rebaixar highRisk e cair em NOT_REQUIRED.
    await assert.rejects(
      () => procurementService.upsertSupplierQualification(
        withTenant({ supplierPersonId: supplier.id, highRisk: false }),
        tenant.userId,
        { canApprove: false },
        transaction
      ),
      (err) => { assert.equal(err.code, 'SUPPLIER_QUALIFICATION_DOWNGRADE_REQUIRES_APPROVAL'); return true; }
    );

    // Com procurement:approve, a mudança é aceita normalmente.
    const downgraded = await procurementService.upsertSupplierQualification(
      withTenant({ supplierPersonId: supplier.id, highRisk: false }),
      tenant.userId,
      { canApprove: true },
      transaction
    );
    assert.equal(downgraded.dueDiligenceStatus, 'NOT_REQUIRED');
  });
});

// Item 2 — over-receipt sem cap: receber mais do que o saldo do PO não pode fazer o excedente
// entrar automaticamente no payable; só a quantidade cheia (físico) vai pro estoque.
test('confirmGoodsReceipt: over-receipt capa o payable no saldo do PO, excedente só fica na discrepância', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order } = await fullProcurementCycle(transaction, { item, quantity: 10, unitPrice: 5 });

    const { goodsReceipt, discrepancies } = await procurementService.confirmGoodsReceipt(
      order.id, tenant.groupId, tenant.companyId,
      { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 15 }] },
      actorOf(),
      transaction
    );

    const overReceipt = discrepancies.find((d) => d.discrepancyType === 'OVER_RECEIPT');
    assert.ok(overReceipt, 'precisa abrir uma discrepância OVER_RECEIPT');
    assert.equal(Number(overReceipt.expectedValue), 10);
    assert.equal(Number(overReceipt.receivedValue), 15);

    assert.ok(goodsReceipt.financialEntryId, 'payable capado ainda deve ser criado para o saldo do PO');
    const entry = await FinancialEntry.findByPk(goodsReceipt.financialEntryId, { transaction });
    // Capado em 10 (saldo do PO) x 5 (unitPrice) = 50, nunca 15 x 5 = 75.
    assert.equal(Number(entry.amount), 50);

    // Resolver REJECTANDO o excedente: nenhum lançamento financeiro adicional é criado.
    const resolvedReject = await procurementService.resolveDiscrepancy(
      overReceipt.id, tenant.groupId, tenant.companyId, { resolution: 'REJECTED' }, actorOf(), transaction
    );
    assert.equal(resolvedReject.status, 'REJECTED');
    const extraEntryAfterReject = await FinancialEntry.findOne({
      where: { groupId: tenant.groupId, companyId: tenant.companyId, idempotencyKey: `goods-receipt:${goodsReceipt.id}:over-receipt-accepted:${overReceipt.id}` },
      transaction,
    });
    assert.equal(extraEntryAfterReject, null, 'rejeitar o excedente nunca gera lançamento financeiro');
  });
});

test('resolveDiscrepancy: aceitar um OVER_RECEIPT cria um FinancialEntry adicional pelo valor do excedente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order } = await fullProcurementCycle(transaction, { item, quantity: 10, unitPrice: 4 });

    const { goodsReceipt, discrepancies } = await procurementService.confirmGoodsReceipt(
      order.id, tenant.groupId, tenant.companyId,
      { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 12 }] },
      actorOf(),
      transaction
    );
    const overReceipt = discrepancies.find((d) => d.discrepancyType === 'OVER_RECEIPT');
    assert.ok(overReceipt);

    const resolved = await procurementService.resolveDiscrepancy(
      overReceipt.id, tenant.groupId, tenant.companyId, { resolution: 'ACCEPTED' }, actorOf(), transaction
    );
    assert.equal(resolved.status, 'ACCEPTED');

    // Excedente = 2 unidades x 4 = 8, lançado como payable adicional (DEBIT/PAYABLE).
    const extraEntry = await FinancialEntry.findOne({
      where: { groupId: tenant.groupId, companyId: tenant.companyId, idempotencyKey: `goods-receipt:${goodsReceipt.id}:over-receipt-accepted:${overReceipt.id}` },
      transaction,
    });
    assert.ok(extraEntry, 'precisa existir um FinancialEntry adicional para o excedente aceito');
    assert.equal(Number(extraEntry.amount), 8);
    assert.equal(extraEntry.nature, 'PAYABLE');
  });
});

// Item 3 — cancelPolicy: apólice precisa poder ser cancelada formalmente (status CANCELED),
// bloqueando qualquer nova transição depois disso.
test('insurance.cancelPolicy: cancela uma apólice ISSUED/ACTIVE exigindo reason e bloqueia reemissão', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.quotePolicy(policy.id, {}, actorWithTenant(), transaction);
    await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-01-01', expiryDate: '2026-12-31' },
      actorWithTenant(),
      transaction
    );

    await assert.rejects(
      () => insuranceService.cancelPolicy(policy.id, {}, actorWithTenant(), transaction),
      (err) => { assert.equal(err.code, 'INSURANCE_POLICY_CANCEL_REASON_REQUIRED'); return true; }
    );

    const canceled = await insuranceService.cancelPolicy(
      policy.id, { reason: 'imóvel vendido — apólice não é mais necessária' }, actorWithTenant(), transaction
    );
    assert.equal(canceled.status, 'CANCELED');

    await assert.rejects(
      () => insuranceService.cancelPolicy(policy.id, { reason: 'tentar cancelar de novo' }, actorWithTenant(), transaction),
      (err) => { assert.equal(err.code, 'INSURANCE_POLICY_INVALID_STATUS'); return true; }
    );
  });
});
