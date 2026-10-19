'use strict';

// Marco 7 — trilha de auditoria com ANTES/DEPOIS (apontamento do Patrick na página de entrega,
// seção "Amostras reais do audit_log", 19/10/2026): várias ações do Marco 7 gravavam a linha em
// "audit"."audit_log" sem beforeJson/afterJson (ASSET_TRANSFERRED, GOODS_RECEIPT_CONFIRMED,
// INVENTORY_COUNT_OPENED/COMPLETED, ...), então a trilha dizia "aconteceu" mas não "o que mudou".
// Regra: criação grava afterJson; transição/atualização grava beforeJson E afterJson.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const receiptsService = require('../src/features/inventory/receipts.service');
const receiptOcr = require('../src/features/inventory/receiptOcr.service');
const requisitionsService = require('../src/features/inventory/requisitions.service');
const countsService = require('../src/features/inventory/counts.service');
const assetsService = require('../src/features/inventory/assets.service');
const toolLoansService = require('../src/features/inventory/toolLoans.service');
const maintenanceService = require('../src/features/inventory/maintenance.service');
const lossCasesService = require('../src/features/inventory/lossCases.service');
const nay = require('../src/features/inventory/inventoryNay.service');
const procurementService = require('../src/features/procurement/procurement.service');
const filesService = require('../src/features/files/files.service');
const { AuditLog, User, Person } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

const withTenant = (fields) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields });

async function secondUser(transaction) {
  const suffix = uniqueSuffix();
  return User.create(
    { name: `QA M7 audit decisor ${suffix}`, email: `qa-m7-audit-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
    { transaction }
  );
}

async function auditRow(action, entityId, transaction) {
  const row = await AuditLog.findOne({ where: { action, entityId }, order: [['occurred_at', 'DESC']], transaction });
  assert.ok(row, `linha de audit_log ${action} para ${entityId} deveria existir`);
  return row;
}

async function expectCreation(action, entityId, transaction) {
  const row = await auditRow(action, entityId, transaction);
  assert.ok(row.afterJson && Object.keys(row.afterJson).length > 0, `${action}: afterJson obrigatório em criação`);
  return row;
}

async function expectTransition(action, entityId, transaction) {
  const row = await auditRow(action, entityId, transaction);
  assert.ok(row.beforeJson && Object.keys(row.beforeJson).length > 0, `${action}: beforeJson obrigatório em transição`);
  assert.ok(row.afterJson && Object.keys(row.afterJson).length > 0, `${action}: afterJson obrigatório em transição`);
  return row;
}

async function evidence(transaction) {
  return filesService.uploadFile(
    withTenant({ fileName: 'evidencia-m7-audit.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('EVIDENCIA M7 AUDIT').toString('base64'), category: 'generic' }),
    tenant.userId,
    transaction
  );
}

test('Marco 7 / estoque: recebimento, OCR, requisição, contagem e NAY gravam antes/depois', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const decider = await secondUser(transaction);
    const suffix = uniqueSuffix();
    const item = await itemsService.createItem(withTenant({ name: `M7 AUDIT Item ${suffix}`, sku: `M7A-${suffix}`, unitOfMeasure: 'UN', minimumQuantity: 50 }), tenant.userId, transaction);
    const warehouse = await itemsService.createLocation(withTenant({ name: `M7 AUDIT Almox ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);

    // Recebimento DRAFT -> REVIEWED -> COMPLETED
    const receipt = await receiptsService.createReceipt(withTenant({ destinationLocationId: warehouse.id, items: [{ inventoryItemId: item.id, quantity: 20, unitCost: 4 }] }), tenant.userId, transaction);
    const created = await expectCreation('INVENTORY_RECEIPT_CREATED', receipt.id, transaction);
    assert.equal(created.afterJson.status, 'DRAFT');
    await receiptsService.reviewReceipt(receipt.id, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await receiptsService.confirmReceipt(receipt.id, { userId: tenant.userId, canApprove: true }, tenant.groupId, tenant.companyId, transaction);
    const completed = await expectTransition('INVENTORY_RECEIPT_COMPLETED', receipt.id, transaction);
    assert.equal(completed.beforeJson.status, 'REVIEWED');
    assert.equal(completed.afterJson.status, 'COMPLETED');

    // Movimento manual (criação)
    const movement = await movementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 5, destinationLocationId: warehouse.id, sourceType: 'MANUAL', reason: 'Entrada M7 audit' }),
      { userId: tenant.userId, canApprove: true },
      transaction
    );
    await expectCreation('INVENTORY_MOVEMENT_RECORDED', movement.id, transaction);

    // OCR de NF (sem provedor: NOT_CONFIGURED, mas a ação é auditada com o resultado)
    const ocr = await receiptOcr.suggestReceiptFromInvoice(
      withTenant({ fileName: 'nf-m7-audit.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4 NF M7 audit').toString('base64') }),
      tenant.userId,
      transaction
    );
    const ocrRow = await AuditLog.findOne({ where: { action: 'INVENTORY_RECEIPT_OCR_SUGGESTED' }, order: [['occurred_at', 'DESC']], transaction });
    assert.ok(ocrRow && ocrRow.afterJson && ocrRow.afterJson.status === ocr.status, 'OCR: afterJson com o status da leitura');

    // Requisição de material: criação -> decisão -> entrega
    const requisition = await requisitionsService.createRequisition(withTenant({ warehouseLocationId: warehouse.id, items: [{ inventoryItemId: item.id, quantity: 2 }] }), tenant.userId, transaction);
    await expectCreation('INVENTORY_REQUISITION_CREATED', requisition.id, transaction);
    await requisitionsService.decideRequisition(requisition.id, 'APPROVED', decider.id, tenant.groupId, tenant.companyId, transaction);
    const decided = await expectTransition('INVENTORY_REQUISITION_DECIDED', requisition.id, transaction);
    assert.equal(decided.beforeJson.status, 'REQUESTED');
    assert.equal(decided.afterJson.status, 'APPROVED');
    await requisitionsService.issueRequisition(requisition.id, { userId: decider.id, canApprove: true }, tenant.groupId, tenant.companyId, transaction);
    const issued = await expectTransition('INVENTORY_REQUISITION_ISSUED', requisition.id, transaction);
    assert.equal(issued.afterJson.status, 'ISSUED');

    // NAY: gera, rejeita uma, regenera e aprova outra
    const gen = await nay.generatePurchaseSuggestions(withTenant({ inventoryItemId: item.id }), tenant.userId, transaction);
    assert.ok(gen.aiRunId || gen.suggestions.length > 0);
    const genRow = await AuditLog.findOne({ where: { action: 'INVENTORY_NAY_SUGGESTIONS_GENERATED' }, order: [['occurred_at', 'DESC']], transaction });
    assert.ok(genRow && genRow.afterJson, 'NAY gerar: afterJson');
    const s1 = gen.suggestions.find((s) => s.inventoryItemId === item.id);
    assert.ok(s1, 'sugestão para o item abaixo do mínimo');
    await nay.rejectPurchaseSuggestion(s1.id, tenant.groupId, tenant.companyId, { reason: 'Teste M7 audit' }, { userId: tenant.userId }, transaction);
    await expectTransition('INVENTORY_NAY_SUGGESTION_REJECTED', s1.id, transaction);
    const item2 = await itemsService.createItem(withTenant({ name: `M7 AUDIT Item B ${suffix}`, sku: `M7B-${suffix}`, unitOfMeasure: 'UN', minimumQuantity: 10 }), tenant.userId, transaction);
    await movementsService.recordMovement(
      withTenant({ inventoryItemId: item2.id, movementType: 'IN', quantity: 3, destinationLocationId: warehouse.id, sourceType: 'MANUAL', reason: 'Entrada M7 audit B' }),
      { userId: tenant.userId, canApprove: true },
      transaction
    );
    const regen = await nay.generatePurchaseSuggestions(withTenant({ inventoryItemId: item2.id }), tenant.userId, transaction);
    const s2 = regen.suggestions.find((s) => s.inventoryItemId === item2.id);
    assert.ok(s2);
    await nay.approvePurchaseSuggestion(s2.id, tenant.groupId, tenant.companyId, {}, { userId: tenant.userId }, transaction);
    await expectTransition('INVENTORY_NAY_SUGGESTION_ACCEPTED', s2.id, transaction);

    // Contagem: abre -> conta -> conclui
    const count = await countsService.openCount(withTenant({ locationId: warehouse.id }), tenant.userId, transaction);
    await expectCreation('INVENTORY_COUNT_OPENED', count.id, transaction);
    await countsService.addCountItem(count.id, tenant.groupId, tenant.companyId, { inventoryItemId: item.id, countedQuantity: 22 }, transaction);
    await countsService.completeCount(count.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    const countDone = await expectTransition('INVENTORY_COUNT_COMPLETED', count.id, transaction);
    assert.equal(countDone.beforeJson.status, 'OPEN');
    assert.equal(countDone.afterJson.status, 'COMPLETED');
  });
});

test('Marco 7 / patrimônio: transferência, empréstimo, devolução, manutenção e perda gravam antes/depois', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const decider = await secondUser(transaction);
    const suffix = uniqueSuffix();
    const origin = await itemsService.createLocation(withTenant({ name: `M7 AUDIT Origem ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
    const dest = await itemsService.createLocation(withTenant({ name: `M7 AUDIT Destino ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
    const asset = await assetsService.createAsset(withTenant({ name: `M7 AUDIT Furadeira ${suffix}`, assetTag: `M7A-${suffix}`, currentLocationId: origin.id }), tenant.userId, transaction);

    await assetsService.transferAsset(asset.id, tenant.groupId, tenant.companyId, { destinationLocationId: dest.id }, tenant.userId, transaction);
    const transfer = await expectTransition('ASSET_TRANSFERRED', asset.id, transaction);
    assert.equal(transfer.beforeJson.currentLocationId, origin.id);
    assert.equal(transfer.afterJson.currentLocationId, dest.id);

    const loan = await toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: origin.id }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await expectCreation('TOOL_LOAN_CREATED', loan.id, transaction);
    const { maintenanceOrder } = await toolLoansService.returnTool(loan.id, { conditionCode: 'DAMAGED' }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const returned = await expectTransition('TOOL_LOAN_RETURNED', loan.id, transaction);
    assert.equal(returned.beforeJson.status, 'OPEN');
    assert.equal(returned.afterJson.status, 'RETURNED');
    assert.ok(maintenanceOrder, 'devolução DAMAGED abre OS');
    await expectCreation('MAINTENANCE_ORDER_OPENED', maintenanceOrder.id, transaction);
    await maintenanceService.closeMaintenanceOrder(maintenanceOrder.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    const closed = await expectTransition('MAINTENANCE_ORDER_CLOSED', maintenanceOrder.id, transaction);
    assert.equal(closed.beforeJson.status, 'OPEN');
    assert.equal(closed.afterJson.status, 'CLOSED');

    const ev = await evidence(transaction);
    const lossCase = await lossCasesService.openLossCase(withTenant({ assetId: asset.id, context: 'Extravio M7 audit', evidenceFileIds: [ev.id] }), tenant.userId, transaction);
    await expectCreation('INVENTORY_LOSS_CASE_OPENED', lossCase.id, transaction);
    await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', { userId: decider.id, canApprove: true }, transaction, {});
    const lossDecided = await expectTransition('INVENTORY_LOSS_CASE_DECIDED', lossCase.id, transaction);
    assert.notEqual(lossDecided.beforeJson.status, 'APPROVED');
  });
});

test('Marco 7 / compras: requisição, decisão, PO, recebimento, cancelamento e fornecedor gravam antes/depois', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const decider = await secondUser(transaction);
    const suffix = uniqueSuffix();
    const item = await itemsService.createItem(withTenant({ name: `M7 AUDIT Compra ${suffix}`, sku: `M7C-${suffix}`, unitOfMeasure: 'UN' }), tenant.userId, transaction);
    const warehouse = await itemsService.createLocation(withTenant({ name: `M7 AUDIT Almox C ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);

    const request = await procurementService.createPurchaseRequest(withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }), tenant.userId, transaction);
    await expectCreation('PURCHASE_REQUEST_CREATED', request.id, transaction);
    await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', decider.id, transaction);
    const prDecided = await expectTransition('PURCHASE_REQUEST_DECIDED', request.id, transaction);
    assert.equal(prDecided.beforeJson.status, 'REQUESTED');
    assert.equal(prDecided.afterJson.status, 'APPROVED');

    const quotation = await procurementService.createQuotation(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(quotation.id, tenant.groupId, tenant.companyId, { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 3 }] }, transaction);
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    await expectTransition('PURCHASE_ORDER_CREATED', order.id, transaction);

    const { goodsReceipt } = await procurementService.confirmGoodsReceipt(
      order.id, tenant.groupId, tenant.companyId,
      { destinationLocationId: warehouse.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 4 }] },
      { userId: tenant.userId, canApprove: true },
      transaction
    );
    const gr = await expectTransition('GOODS_RECEIPT_CONFIRMED', goodsReceipt.id, transaction);
    assert.equal(Number(gr.beforeJson.items[0].receivedQuantity), 0);
    assert.equal(Number(gr.afterJson.items[0].receivedQuantity), 4);

    await procurementService.cancelPurchaseOrder(order.id, tenant.groupId, tenant.companyId, { reason: 'Cancelamento M7 audit' }, { userId: tenant.userId, canApprove: true }, transaction);
    const canceled = await expectTransition('PURCHASE_ORDER_CANCELED', order.id, transaction);
    assert.equal(canceled.beforeJson.status, 'OPEN');
    assert.equal(canceled.afterJson.status, 'CANCELED');

    const supplier = await Person.create(withTenant({ personType: 'PJ', legalName: `M7 AUDIT Fornecedor ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId }), { transaction });
    const qualification = await procurementService.upsertSupplierQualification(withTenant({ supplierPersonId: supplier.id, highRisk: true }), tenant.userId, { canApprove: true }, transaction);
    await expectCreation('SUPPLIER_QUALIFICATION_UPDATED', qualification.id, transaction);
    await procurementService.upsertSupplierQualification(withTenant({ supplierPersonId: supplier.id, highRisk: true, validUntil: '2027-12-31' }), tenant.userId, { canApprove: true }, transaction);
    await expectTransition('SUPPLIER_QUALIFICATION_UPDATED', qualification.id, transaction);
    await procurementService.decideSupplierDueDiligence(qualification.id, tenant.groupId, tenant.companyId, { decision: 'APPROVED' }, { userId: decider.id, canApprove: true }, transaction);
    const dd = await expectTransition('SUPPLIER_DUE_DILIGENCE_DECIDED', qualification.id, transaction);
    assert.equal(dd.beforeJson.dueDiligenceStatus, 'PENDING');
    assert.equal(dd.afterJson.dueDiligenceStatus, 'APPROVED');
  });
});
