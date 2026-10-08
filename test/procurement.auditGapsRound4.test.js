'use strict';

// Auditoria externa Nayara, Marco 7 (Anexo I, "COMPRAS/PROCUREMENT + SEGUROS — BLINDADO + GUIA")
// — 2 lacunas reais fechadas nesta rodada:
//
// GAP 1 ("cancel/return = compensação", seção Integração): cancelar um PO que já teve
// recebimento confirmado só estornava o payable financeiro — o material ficava fisicamente no
// estoque mesmo com a compra cancelada. cancelPurchaseOrder agora gera um movimento OUT real
// (reaproveitando movements.service) pra cada item já recebido, revertendo o saldo físico.
//
// GAP 2 ("RFQ sem convite dirigido a fornecedores específicos"): createQuotation aceita agora
// uma lista opcional invitedSupplierIds; se informada, só esses fornecedores podem ofertar.
// BLOQUEIO DE INFRAESTRUTURA conhecido nesta sessão (mesmo documentado em test/crm.carts.test.js
// e src/features/people/personMerge.service.js): a migration 20260101000312 (coluna
// invited_supplier_ids) não pôde ser aplicada — credencial de DDL rejeitada pelo Postgres, sem
// acesso para corrigi-la. Os testes de GAP 2 fazem a mesma checagem de pré-condição: se a coluna
// existir, rodam de verdade; se não, SKIP com o motivo exato (nunca fingem sucesso).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const procurementService = require('../src/features/procurement/procurement.service');
const { User } = require('../src/models');
const AppError = require('../src/utils/AppError');

let tenant;
let quotationInvitationsColumnExists = false;

before(async () => {
  tenant = await getSeedTenant();
  const [rows] = await sequelize.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'procurement' AND table_name = 'quotations' AND column_name = 'invited_supplier_ids'`
  );
  quotationInvitationsColumnExists = rows.length > 0;
});

after(async () => {
  await sequelize.close();
});

const GAP2_SKIP_REASON =
  'procurement.quotations.invited_supplier_ids ainda não existe no banco: migration ' +
  '20260101000312-add-invited-supplier-ids-to-quotations.js não pôde ser aplicada (credencial ' +
  'DB_MIGRATION_USER em .env.migration.local rejeitada pelo Postgres nesta sessão, mesmo bloqueio ' +
  'já documentado em test/crm.carts.test.js). Rode ' +
  '"DB_USER=nayara_migration DB_PASSWORD=<senha correta> npm run migrate" e reexecute este teste.';

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

function actorOf(extra) {
  return { userId: tenant.userId, canApprove: true, ...extra };
}

async function createSecondApprover(transaction) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  return User.create(
    { name: `QA PROC R4 segundo aprovador ${suffix}`, email: `qa-proc-r4-approver-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
    { transaction }
  );
}

async function createItemAndWarehouse(transaction) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const item = await itemsService.createItem(
    withTenant({ name: `HOMO QA R4 Item ${suffix}`, sku: `SKU-R4-${suffix}`, unitOfMeasure: 'UN' }),
    tenant.userId,
    transaction
  );
  const location = await itemsService.createLocation(
    withTenant({ name: `HOMO QA R4 Deposito ${suffix}`, locationType: 'WAREHOUSE' }),
    tenant.userId,
    transaction
  );
  return { item, location };
}

async function createAwardedOrder(transaction, { item, quantity = 10, unitPrice = 3 }) {
  const request = await procurementService.createPurchaseRequest(
    withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity }] }),
    tenant.userId,
    transaction
  );
  const secondApprover = await createSecondApprover(transaction);
  await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', secondApprover.id, transaction);
  const quotation = await procurementService.createQuotation(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  const offer = await procurementService.submitSupplierOffer(
    quotation.id, tenant.groupId, tenant.companyId,
    { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice }] },
    transaction
  );
  const order = await procurementService.awardSupplierOffer(offer.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  return { request, order };
}

// --- GAP 1 ---

test('GAP1-COMPRAS: cancelPurchaseOrder com recebimento confirmado estorna o estoque (saldo volta ao original) E o payable financeiro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { order } = await createAwardedOrder(transaction, { item, quantity: 10, unitPrice: 3 });

    const quantityBefore = await movementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);

    const { discrepancies } = await procurementService.confirmGoodsReceipt(
      order.id, tenant.groupId, tenant.companyId,
      { destinationLocationId: location.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 10 }] },
      actorOf(),
      transaction
    );
    assert.equal(discrepancies.length, 0);

    const balanceAfterReceipt = await movementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balanceAfterReceipt, quantityBefore + 10, 'recebimento precisa ter somado 10 ao saldo');

    const goodsReceipts = await require('../src/models').GoodsReceipt.findAll({ where: { purchaseOrderId: order.id }, transaction });
    assert.equal(goodsReceipts.length, 1);
    assert.ok(goodsReceipts[0].financialEntryId, 'recebimento confirmado precisa ter gerado um payable');
    const payableBefore = await require('../src/models').FinancialEntry.findByPk(goodsReceipts[0].financialEntryId, { transaction });
    assert.notEqual(payableBefore.status, 'REVERSED');

    const { order: canceled, reversedStockMovementIds, reversedFinancialEntryIds } = await procurementService.cancelPurchaseOrder(
      order.id, tenant.groupId, tenant.companyId, { reason: 'compra cancelada após recebimento' }, actorOf(), transaction
    );

    assert.equal(canceled.status, 'CANCELED');
    assert.equal(reversedStockMovementIds.length, 1, 'precisa ter gerado exatamente 1 movimento de estorno de estoque');
    assert.equal(reversedFinancialEntryIds.length, 1, 'precisa ter estornado o payable como já acontecia');

    const balanceAfterCancel = await movementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balanceAfterCancel, quantityBefore, 'estoque precisa voltar ao saldo original após o cancelamento');

    const payableAfter = await require('../src/models').FinancialEntry.findByPk(goodsReceipts[0].financialEntryId, { transaction });
    assert.equal(payableAfter.status, 'REVERSED', 'payable financeiro precisa continuar sendo estornado, como já acontecia');

    const movement = await require('../src/models').InventoryMovement.findByPk(reversedStockMovementIds[0], { transaction });
    assert.equal(movement.movementType, 'OUT');
    assert.equal(Number(movement.quantity), 10);
    assert.equal(movement.sourceType, 'PURCHASE_ORDER_CANCEL');
    assert.equal(movement.sourceId, order.id);
    assert.ok(movement.reason);
  });
});

test('GAP1-COMPRAS: cancelPurchaseOrder sem nenhum recebimento confirmado não gera movimento de estoque (nada a estornar)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item } = await createItemAndWarehouse(transaction);
    const { order } = await createAwardedOrder(transaction, { item, quantity: 5, unitPrice: 2 });

    const { order: canceled, reversedStockMovementIds, reversedFinancialEntryIds } = await procurementService.cancelPurchaseOrder(
      order.id, tenant.groupId, tenant.companyId, {}, actorOf(), transaction
    );

    assert.equal(canceled.status, 'CANCELED');
    assert.equal(reversedStockMovementIds.length, 0);
    assert.equal(reversedFinancialEntryIds.length, 0);
  });
});

// --- GAP 2 ---

test('GAP2-COMPRAS: RFQ com invitedSupplierIds recusa oferta de fornecedor não convidado e aceita de fornecedor convidado', async (t) => {
  if (!quotationInvitationsColumnExists) {
    t.skip(GAP2_SKIP_REASON);
    return;
  }
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item } = await createItemAndWarehouse(transaction);
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    const secondApprover = await createSecondApprover(transaction);
    await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', secondApprover.id, transaction);

    const invitedSupplierId = tenant.userId;
    const notInvitedSupplierId = secondApprover.id;

    const quotation = await procurementService.createQuotation(
      request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction,
      { invitedSupplierIds: [invitedSupplierId] }
    );

    await assert.rejects(
      () => procurementService.submitSupplierOffer(
        quotation.id, tenant.groupId, tenant.companyId,
        { supplierPersonId: notInvitedSupplierId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 5 }] },
        transaction
      ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'PROCUREMENT_SUPPLIER_NOT_INVITED');
        return true;
      }
    );

    const offer = await procurementService.submitSupplierOffer(
      quotation.id, tenant.groupId, tenant.companyId,
      { supplierPersonId: invitedSupplierId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 5 }] },
      transaction
    );
    assert.equal(offer.supplierPersonId, invitedSupplierId);
  });
});

test('GAP2-COMPRAS: RFQ sem invitedSupplierIds preserva o comportamento antigo — qualquer fornecedor pode ofertar', async (t) => {
  if (!quotationInvitationsColumnExists) {
    t.skip(GAP2_SKIP_REASON);
    return;
  }
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item } = await createItemAndWarehouse(transaction);
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }),
      tenant.userId,
      transaction
    );
    const secondApprover = await createSecondApprover(transaction);
    await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', secondApprover.id, transaction);

    const quotation = await procurementService.createQuotation(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);

    const anyUnrelatedSupplierId = secondApprover.id;
    const offer = await procurementService.submitSupplierOffer(
      quotation.id, tenant.groupId, tenant.companyId,
      { supplierPersonId: anyUnrelatedSupplierId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 5 }] },
      transaction
    );
    assert.equal(offer.supplierPersonId, anyUnrelatedSupplierId);
  });
});
