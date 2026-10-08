'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const requisitionsService = require('../src/features/inventory/requisitions.service');
const lossCasesService = require('../src/features/inventory/lossCases.service');
const procurementService = require('../src/features/procurement/procurement.service');
const projectsService = require('../src/features/construction/projects.service');
const settingsService = require('../src/features/settings/settings.service');
const filesService = require('../src/features/files/files.service');
const nay = require('../src/features/inventory/inventoryNay.service');
const { AiRecommendation, AiRun, PurchaseRequestItem, InventoryMovement, InventoryLossCase, Project, Person } = require('../src/models');
const AppError = require('../src/utils/AppError');

// NAY Estoque — EST-013 ("NAY pode sugerir compra, risco de falta ou anomalia, mas não efetiva
// compra/baixa sozinha"), Guia §12 ("sugestão não cria pedido de compra sem workflow
// autorizado") e EST-TS-14 ("IA sugere culpa -> sem efeito financeiro").

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
  return itemsService.createItem(withTenant({ name: `NAY QA Item ${suffix}`, sku: `NAY-${suffix}`, unitOfMeasure: 'UN', ...extra }), tenant.userId, transaction);
}
async function createWarehouse(transaction) {
  return itemsService.createLocation(withTenant({ name: `NAY QA Almox ${uniqueSuffix()}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
}
async function stockIn(item, location, quantity, transaction) {
  return movementsService.recordMovement(
    withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity, destinationLocationId: location.id, sourceType: 'MANUAL' }),
    actor(),
    transaction
  );
}
async function createActiveProjectWithSite(transaction) {
  const project = await projectsService.createProject(withTenant({ name: `NAY QA Obra ${uniqueSuffix()}` }), tenant.userId, transaction);
  // Fixture: coloca a obra direto em ACTIVE (o workflow completo de transição de obra não é o
  // objeto deste teste — só precisamos de uma "obra ativa" consumindo material).
  await Project.update({ status: 'ACTIVE' }, { where: { id: project.id }, transaction });
  const site = await itemsService.createLocation(
    withTenant({ name: `NAY QA Canteiro ${uniqueSuffix()}`, locationType: 'PROJECT_SITE', projectId: project.id }),
    tenant.userId,
    transaction
  );
  return { project, site };
}
async function suggestionsForItem(itemId, transaction) {
  return AiRecommendation.findAll({ where: { recommendationType: nay.RECOMMENDATION_TYPE_PURCHASE, relatedEntityId: itemId }, transaction });
}

// --- Regra pura -------------------------------------------------------------------------

test('NAY Estoque (regra): sem nenhum sinal de demanda não inventa necessidade de compra', () => {
  assert.equal(nay.computePurchaseSignals({ quantityOnHand: 0, minimumQuantity: null, consumed: 0, windowDays: 90, leadTimeDays: 7, pendingQuantity: 0 }), null);
});

test('NAY Estoque (regra): saldo projetado acima do ponto de reposição não gera sugestão', () => {
  // mínimo 10 + 1/dia * 7 dias = ponto 17; saldo 50 -> nada a sugerir.
  assert.equal(nay.computePurchaseSignals({ quantityOnHand: 50, minimumQuantity: 10, consumed: 90, windowDays: 90, leadTimeDays: 7, pendingQuantity: 0 }), null);
});

test('NAY Estoque (regra): consumo + obra pendente + lead time + mínimo compõem a sugestão e o risco de falta', () => {
  const s = nay.computePurchaseSignals({ quantityOnHand: 25, minimumQuantity: 10, consumed: 75, windowDays: 90, leadTimeDays: 14, pendingQuantity: 20 });
  assert.ok(s);
  assert.equal(s.projectedOnHand, 5);
  assert.equal(s.dailyConsumptionRate, 0.8333);
  assert.equal(s.reorderPoint, 21.6667);
  // alvo = 10 + 0.8333 * (14 + 30) = 46.6667 -> compra = 46.6667 - 5 = 41.67 (arredonda pra cima)
  assert.equal(s.suggestedQuantity, 41.67);
  assert.equal(s.daysOfCoverage, 6);
  assert.equal(s.riskLevel, 'HIGH', 'cobertura de 6 dias < lead time de 14 dias = risco de falta');
  assert.equal(s.stockoutRisk, true);
});

// --- Fluxo completo com banco -----------------------------------------------------------

test('EST-013/§12: NAY sugere compra a partir de consumo, obra ativa, lead time e mínimo — e NÃO cria pedido sozinha', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const item = await createItem(transaction, { minimumQuantity: 10 });
    const warehouse = await createWarehouse(transaction);
    const { project, site } = await createActiveProjectWithSite(transaction);
    await settingsService.upsertSetting('inventory.nay_default_lead_time_days', 14, tenant, tenant.userId, transaction);

    await stockIn(item, warehouse, 100, transaction);
    // Consumo real: requisição da obra ativa entregue (OUT 75 do almoxarifado).
    const issued = await requisitionsService.createRequisition(
      withTenant({ warehouseLocationId: warehouse.id, projectLocationId: site.id, projectId: project.id, items: [{ inventoryItemId: item.id, quantity: 75 }] }),
      tenant.userId,
      transaction
    );
    await requisitionsService.decideRequisition(issued.id, 'APPROVED', tenant.userId, transaction);
    await requisitionsService.issueRequisition(issued.id, actor(), transaction);
    // Demanda comprometida da obra ativa ainda não baixada.
    await requisitionsService.createRequisition(
      withTenant({ warehouseLocationId: warehouse.id, projectLocationId: site.id, projectId: project.id, items: [{ inventoryItemId: item.id, quantity: 20 }] }),
      tenant.userId,
      transaction
    );

    const purchaseItemsBefore = await PurchaseRequestItem.count({ where: { inventoryItemId: item.id }, transaction });
    const result = await nay.generatePurchaseSuggestions(withTenant({ inventoryItemId: item.id }), tenant.userId, transaction);

    assert.deepEqual(result.decisionsMade, []);
    const mine = result.suggestions.filter((s) => s.inventoryItemId === item.id && s.locationId === warehouse.id);
    assert.equal(mine.length, 1, 'uma sugestão para o par item/almoxarifado');
    const suggestion = mine[0];
    assert.equal(suggestion.status, 'PENDING');
    assert.equal(suggestion.method, 'RULE_BASED');
    assert.equal(suggestion.quantityOnHand, 25);
    assert.equal(suggestion.pendingProjectDemand, 20);
    assert.equal(suggestion.consumedInWindow, 75);
    assert.equal(suggestion.leadTimeDays, 14);
    assert.equal(suggestion.leadTimeSource, 'TENANT_SETTING');
    assert.equal(suggestion.thresholdSource, 'ITEM_MINIMUM_QUANTITY');
    assert.equal(suggestion.suggestedQuantity, 41.67);
    assert.equal(suggestion.riskLevel, 'HIGH');
    assert.equal(suggestion.activeProjects.length, 1);
    assert.equal(suggestion.activeProjects[0].projectId, project.id);
    assert.ok(suggestion.reasons.length >= 4);

    // A execução foi registrada no schema "ai" (auditoria de orquestração).
    const run = await AiRun.findByPk(result.aiRunId, { transaction });
    assert.equal(run.agentName, 'NAY_ESTOQUE');

    // EST-013: sugerir NÃO abre requisição de compra.
    const purchaseItemsAfter = await PurchaseRequestItem.count({ where: { inventoryItemId: item.id }, transaction });
    assert.equal(purchaseItemsAfter, purchaseItemsBefore, 'a sugestão nunca pode criar pedido/requisição de compra sozinha');

    // Recalcular não duplica a mesma necessidade aberta.
    const again = await nay.generatePurchaseSuggestions(withTenant({ inventoryItemId: item.id }), tenant.userId, transaction);
    assert.equal(again.suggestions.find((s) => s.inventoryItemId === item.id).id, suggestion.id);
    assert.equal((await suggestionsForItem(item.id, transaction)).length, 1);

    const listed = await nay.listPurchaseSuggestions(transaction, { inventoryItemId: item.id });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, suggestion.id);
  });
});

test('EST-013: só a aprovação HUMANA abre a requisição de compra (REQUESTED, ainda sujeita ao workflow de Compras)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const item = await createItem(transaction, { minimumQuantity: 10 });
    const warehouse = await createWarehouse(transaction);
    await stockIn(item, warehouse, 3, transaction);

    const { suggestions } = await nay.generatePurchaseSuggestions(withTenant({ inventoryItemId: item.id }), tenant.userId, transaction);
    const suggestion = suggestions.find((s) => s.inventoryItemId === item.id);
    assert.ok(suggestion);
    assert.equal(suggestion.suggestedQuantity, 7, 'sem consumo: repõe até o mínimo (10 - 3)');
    assert.equal(suggestion.riskLevel, 'MEDIUM');

    // Humano ajusta a quantidade e aprova.
    const { suggestion: accepted, purchaseRequest } = await nay.approvePurchaseSuggestion(suggestion.id, { quantity: 12, notes: 'Comprar lote fechado.' }, { userId: tenant.userId }, transaction);
    assert.equal(purchaseRequest.status, 'REQUESTED', 'nasce como requisição, ainda precisa ser aprovada no fluxo de Compras');
    assert.equal(purchaseRequest.items.length, 1);
    assert.equal(purchaseRequest.items[0].inventoryItemId, item.id);
    assert.equal(Number(purchaseRequest.items[0].quantity), 12);
    assert.match(purchaseRequest.notes, new RegExp(suggestion.id));

    assert.equal(accepted.status, 'ACCEPTED');
    assert.equal(accepted.decidedByUserId, tenant.userId);
    assert.equal(accepted.decision.purchaseRequestId, purchaseRequest.id);
    assert.equal(accepted.decision.suggestedQuantity, 7);
    assert.equal(accepted.decision.approvedQuantity, 12);

    // Não reaplica: uma sugestão decidida não pode ser aprovada de novo (sem pedido duplicado).
    await assert.rejects(
      () => nay.approvePurchaseSuggestion(suggestion.id, {}, { userId: tenant.userId }, transaction),
      (err) => err instanceof AppError && err.code === 'INVENTORY_NAY_SUGGESTION_INVALID_TRANSITION'
    );
    assert.equal(await PurchaseRequestItem.count({ where: { inventoryItemId: item.id }, transaction }), 1);

    await assert.rejects(
      () => nay.approvePurchaseSuggestion('00000000-0000-0000-0000-000000000000', {}, { userId: tenant.userId }, transaction),
      (err) => err instanceof AppError && err.code === 'INVENTORY_NAY_SUGGESTION_NOT_FOUND'
    );
  });
});

test('NAY Estoque: quantidade inválida na aprovação é recusada sem abrir compra', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const item = await createItem(transaction, { minimumQuantity: 5 });
    const warehouse = await createWarehouse(transaction);
    await stockIn(item, warehouse, 1, transaction);
    const { suggestions } = await nay.generatePurchaseSuggestions(withTenant({ inventoryItemId: item.id }), tenant.userId, transaction);
    const suggestion = suggestions.find((s) => s.inventoryItemId === item.id);

    await assert.rejects(
      () => nay.approvePurchaseSuggestion(suggestion.id, { quantity: -3 }, { userId: tenant.userId }, transaction),
      (err) => err instanceof AppError && err.code === 'INVENTORY_NAY_VALIDATION'
    );
    assert.equal(await PurchaseRequestItem.count({ where: { inventoryItemId: item.id }, transaction }), 0);
  });
});

test('NAY Estoque: rejeição humana é respeitada (não reaparece no recálculo) e sugestão sem necessidade expira', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const item = await createItem(transaction, { minimumQuantity: 10 });
    const warehouse = await createWarehouse(transaction);
    await stockIn(item, warehouse, 3, transaction);

    let { suggestions } = await nay.generatePurchaseSuggestions(withTenant({ inventoryItemId: item.id }), tenant.userId, transaction);
    const first = suggestions.find((s) => s.inventoryItemId === item.id);
    const rejected = await nay.rejectPurchaseSuggestion(first.id, { reason: 'Item será descontinuado.' }, { userId: tenant.userId }, transaction);
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.decision.reason, 'Item será descontinuado.');

    const regenerated = await nay.generatePurchaseSuggestions(withTenant({ inventoryItemId: item.id }), tenant.userId, transaction);
    assert.equal(regenerated.suggestions.filter((s) => s.inventoryItemId === item.id).length, 0, 'rejeição recente não é atropelada pela NAY');
    assert.equal(regenerated.suppressedByRecentRejection, 1);

    // Outro item: sugestão PENDING que deixa de ser necessária vira EXPIRED (nunca "aceita sozinha").
    const item2 = await createItem(transaction, { minimumQuantity: 10 });
    await stockIn(item2, warehouse, 3, transaction);
    ({ suggestions } = await nay.generatePurchaseSuggestions(withTenant({ inventoryItemId: item2.id }), tenant.userId, transaction));
    const pending = suggestions.find((s) => s.inventoryItemId === item2.id);
    assert.ok(pending);
    await stockIn(item2, warehouse, 50, transaction);
    const after = await nay.generatePurchaseSuggestions(withTenant({ inventoryItemId: item2.id }), tenant.userId, transaction);
    assert.equal(after.expiredCount, 1);
    const stale = await AiRecommendation.findByPk(pending.id, { transaction });
    assert.equal(stale.status, 'EXPIRED');
    assert.ok(stale.payloadJson.expiredReason);
    assert.equal(stale.decidedByUserId, null);
  });
});

test('NAY Estoque: lead time OBSERVADO no histórico real de Compras (pedido -> recebimento) tem prioridade sobre o padrão', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const item = await createItem(transaction, { minimumQuantity: 5 });
    const warehouse = await createWarehouse(transaction);

    const request = await procurementService.createPurchaseRequest(withTenant({ items: [{ inventoryItemId: item.id, description: item.name, quantity: 10 }] }), tenant.userId, transaction);
    await procurementService.decidePurchaseRequest(request.id, 'APPROVED', tenant.userId, transaction);
    const quotation = await procurementService.createQuotation(request.id, tenant.userId, transaction);
    const offer = await procurementService.submitSupplierOffer(quotation.id, { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice: 4 }] }, transaction);
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.userId, transaction);
    // Fixture: o pedido foi emitido 12 dias antes do recebimento.
    await sequelize.query("UPDATE procurement.purchase_orders SET created_at = NOW() - INTERVAL '12 days' WHERE id = :id", { replacements: { id: order.id }, transaction });
    await procurementService.confirmGoodsReceipt(order.id, { destinationLocationId: warehouse.id, items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: 10 }] }, actor(), transaction);
    await movementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'OUT', quantity: 8, sourceLocationId: warehouse.id, sourceType: 'MANUAL' }),
      actor(),
      transaction
    );

    const { suggestions } = await nay.generatePurchaseSuggestions(withTenant({ inventoryItemId: item.id }), tenant.userId, transaction);
    const s = suggestions.find((x) => x.inventoryItemId === item.id);
    assert.ok(s);
    assert.equal(s.leadTimeSource, 'OBSERVED');
    assert.equal(s.leadTimeDays, 12);
    assert.equal(s.leadTimeSampleSize, 1);
    assert.equal(s.quantityOnHand, 2);
  });
});

test('NAY Estoque: windowDays fora do intervalo é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => nay.generatePurchaseSuggestions(withTenant({ windowDays: 2 }), tenant.userId, transaction),
      (err) => err instanceof AppError && err.code === 'INVENTORY_NAY_VALIDATION'
    );
  });
});

// --- Anomalias em loss_cases (EST-TS-14) -------------------------------------------------

async function evidence(transaction) {
  return filesService.uploadFile(
    withTenant({ fileName: 'evidencia.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from(`EVIDENCIA-${uniqueSuffix()}`).toString('base64'), category: 'generic' }),
    tenant.userId,
    transaction
  );
}

test('EST-TS-14: NAY sinaliza recorrência/valor anômalo em loss_cases SEM decidir, sem baixa e sem efeito financeiro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const item = await createItem(transaction);
    const warehouse = await createWarehouse(transaction);
    await stockIn(item, warehouse, 50, transaction);
    const responsible = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Responsável NAY ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    const file = await evidence(transaction);

    const open = (estimatedCost) =>
      lossCasesService.openLossCase(
        withTenant({ inventoryItemId: item.id, locationId: warehouse.id, quantity: 1, responsiblePersonId: responsible.id, context: 'Material sumiu do almoxarifado.', evidenceFileIds: [file.id], estimatedCost }),
        tenant.userId,
        transaction
      );
    const a = await open(100);
    const b = await open(100);
    const c = await open(1000);

    const analysis = await nay.analyzeLossCaseAnomalies(tenant, {}, transaction);
    assert.equal(analysis.financialEffect, 'NONE');
    assert.deepEqual(analysis.decisionsMade, []);
    assert.match(analysis.disclaimer, /Não atribui culpa/);

    const byId = new Map(analysis.cases.map((x) => [x.lossCaseId, x]));
    for (const lc of [a, b, c]) {
      const codes = byId.get(lc.id).flags.map((f) => f.code);
      assert.ok(codes.includes('RECURRENCE_ITEM_LOCATION'), 'mesmo item/local 3x na janela');
      assert.ok(codes.includes('RECURRENCE_RESPONSIBLE'), 'mesmo responsável 3x na janela');
    }
    assert.ok(byId.get(c.id).flags.some((f) => f.code === 'VALUE_ABOVE_HISTORY'), '1000 > 2x a média (100) dos demais casos do item');
    assert.ok(!byId.get(a.id).flags.some((f) => f.code === 'VALUE_ABOVE_HISTORY'));

    // Nada foi decidido nem baixado pela análise.
    const ids = [a.id, b.id, c.id];
    const reloaded = await InventoryLossCase.findAll({ where: { id: ids }, transaction });
    for (const lc of reloaded) {
      assert.equal(lc.status, 'OPEN');
      assert.equal(lc.decidedByUserId, null);
      assert.equal(lc.resultingMovementId, null);
    }
    assert.equal(await InventoryMovement.count({ where: { sourceType: 'LOSS_CASE', sourceId: ids }, transaction }), 0);

    // A decisão humana continua soberana: rejeitar um caso tira ele da evidência de recorrência.
    await lossCasesService.decideLossCase(a.id, 'REJECTED', actor(), transaction);
    const afterReject = await nay.analyzeLossCaseAnomalies(tenant, { lossCaseId: b.id }, transaction);
    assert.equal(afterReject.cases.length, 1);
    assert.ok(!afterReject.cases[0].flags.some((f) => f.code.startsWith('RECURRENCE_')), 'com só 2 casos válidos não há recorrência');

    // E só a decisão humana (inventory:approve) gera baixa.
    const approved = await lossCasesService.decideLossCase(c.id, 'APPROVED', actor(), transaction);
    assert.equal(approved.status, 'APPROVED');
    assert.ok(approved.resultingMovementId);

    await assert.rejects(
      () => nay.analyzeLossCaseAnomalies(tenant, { lossCaseId: '00000000-0000-0000-0000-000000000000' }, transaction),
      (err) => err instanceof AppError && err.code === 'LOSS_CASE_NOT_FOUND'
    );
  });
});
