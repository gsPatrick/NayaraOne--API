'use strict';

const {
  PurchaseRequest,
  PurchaseRequestItem,
  Quotation,
  SupplierOffer,
  SupplierOfferItem,
  PurchaseOrder,
  PurchaseOrderItem,
  GoodsReceipt,
  GoodsReceiptItem,
  ReceiptDiscrepancy,
  SupplierEvaluation,
} = require('../../models');
const { InventoryStockBalance } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { confirmReceipt: confirmInventoryReceipt, createReceipt: createInventoryReceipt } = require('../inventory/receipts.service');

// Caderno "COMPRAS/PROCUREMENT": REQUEST -> APPROVAL -> RFQ -> COMPARISON -> AWARD -> PO ->
// RECEIPT -> MATCH -> PAYABLE. PO = committed cost (contabilizado só como compromisso, nunca
// lançado no Financeiro aqui — isso é escopo de Financeiro); receipt = Estoque (reusa
// inventory.receipts, nunca duplica a baixa física); invoice match = three-way match PO x
// goods_receipt_item x valor recebido, abre ReceiptDiscrepancy quando não bate.

// --- 1. REQUEST ---
async function createPurchaseRequest(payload, actorUserId, transaction) {
  const { groupId, companyId, projectId, notes, items } = payload;
  if (!groupId || !companyId || !Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "items" (não vazio) são obrigatórios.', 'PURCHASE_REQUEST_VALIDATION');
  }
  for (const line of items) {
    if (!line.description || line.quantity == null || Number(line.quantity) <= 0) {
      throw AppError.badRequest('Cada item precisa de "description" e "quantity" > 0.', 'PURCHASE_REQUEST_VALIDATION');
    }
  }

  const request = await PurchaseRequest.create(
    { groupId, companyId, projectId: projectId || null, notes: notes || null, status: 'REQUESTED', requestedByUserId: actorUserId || null, createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );

  // Caderno Operacional §34: nova requisição de compra deve verificar estoque existente antes
  // de abrir, pra evitar compra duplicada do que já há em almoxarifado. Implementado como
  // AVISO (não bloqueio) — pode haver motivo legítimo de comprar mesmo com saldo existente
  // (ex.: já reservado para outro projeto), mesma lógica de "NAY sugere, nunca decide"
  // (EST-013) aplicada aqui a uma checagem automática de sistema.
  const stockWarnings = [];
  for (const line of items) {
    await PurchaseRequestItem.create(
      { groupId, companyId, purchaseRequestId: request.id, inventoryItemId: line.inventoryItemId || null, description: line.description, quantity: line.quantity },
      { transaction }
    );
    if (line.inventoryItemId) {
      const balances = await InventoryStockBalance.findAll({ where: { inventoryItemId: line.inventoryItemId }, transaction });
      const totalOnHand = balances.reduce((sum, b) => sum + Number(b.quantityOnHand), 0);
      if (totalOnHand >= Number(line.quantity)) {
        stockWarnings.push({ inventoryItemId: line.inventoryItemId, description: line.description, requestedQuantity: line.quantity, availableQuantity: totalOnHand });
      }
    }
  }
  await registrarAuditoria({ groupId, companyId, actorUserId, action: 'PURCHASE_REQUEST_CREATED', entityType: 'PurchaseRequest', entityId: request.id, reason: 'Requisição de compra criada.' }, transaction);

  const created = await getPurchaseRequest(request.id, transaction);
  return { ...created.toJSON(), stockWarnings };
}

async function getPurchaseRequest(id, transaction) {
  const request = await PurchaseRequest.findByPk(id, { include: [{ model: PurchaseRequestItem, as: 'items' }], transaction });
  if (!request) throw AppError.notFound('Requisição de compra não encontrada.', 'PURCHASE_REQUEST_NOT_FOUND');
  return request;
}

async function listPurchaseRequests(transaction, { status } = {}) {
  const where = {};
  if (status) where.status = status;
  return PurchaseRequest.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

// --- 2. APPROVAL ---
async function decidePurchaseRequest(id, decision, actorUserId, transaction) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw AppError.badRequest('"decision" precisa ser "APPROVED" ou "REJECTED".', 'PURCHASE_REQUEST_VALIDATION');
  }
  const request = await PurchaseRequest.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!request) throw AppError.notFound('Requisição de compra não encontrada.', 'PURCHASE_REQUEST_NOT_FOUND');
  if (request.status !== 'REQUESTED') {
    throw AppError.badRequest(`Só é possível decidir uma requisição em REQUESTED (atual: ${request.status}).`, 'PURCHASE_REQUEST_INVALID_TRANSITION');
  }
  request.status = decision;
  request.approvedByUserId = actorUserId || null;
  request.updatedBy = actorUserId || null;
  await request.save({ transaction });
  return request;
}

// --- 3. RFQ ---
async function createQuotation(purchaseRequestId, actorUserId, transaction) {
  const request = await PurchaseRequest.findByPk(purchaseRequestId, { transaction });
  if (!request) throw AppError.notFound('Requisição de compra não encontrada.', 'PURCHASE_REQUEST_NOT_FOUND');
  if (request.status !== 'APPROVED') {
    throw AppError.badRequest('Só é possível abrir cotação para uma requisição APPROVED.', 'QUOTATION_INVALID_SOURCE');
  }
  // BUG REAL CORRIGIDO (auditoria E2E Marco 7, ciclo 5): toda chamada criava uma Quotation
  // nova, mesmo já existindo uma OPEN para a mesma requisição — ao reabrir a tela (reload,
  // nova sessão), as ofertas já submetidas na quotation antiga ficavam órfãs (vinculadas a um
  // quotationId que a UI nunca mais consultava) e sumiam da comparação. Reaproveita a OPEN
  // existente em vez de criar outra (idempotente por requisição).
  const existing = await Quotation.findOne({ where: { purchaseRequestId: request.id, status: 'OPEN' }, transaction });
  if (existing) return existing;
  return Quotation.create(
    { groupId: request.groupId, companyId: request.companyId, purchaseRequestId: request.id, status: 'OPEN', createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );
}

async function submitSupplierOffer(quotationId, payload, transaction) {
  const { supplierPersonId, items } = payload;
  if (!supplierPersonId || !Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('"supplierPersonId" e "items" (não vazio) são obrigatórios.', 'SUPPLIER_OFFER_VALIDATION');
  }
  const quotation = await Quotation.findByPk(quotationId, { transaction });
  if (!quotation) throw AppError.notFound('Cotação não encontrada.', 'QUOTATION_NOT_FOUND');
  if (quotation.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível submeter oferta para uma cotação OPEN (atual: ${quotation.status}).`, 'QUOTATION_INVALID_TRANSITION');
  }

  let totalAmount = 0;
  const offer = await SupplierOffer.create(
    { groupId: quotation.groupId, companyId: quotation.companyId, quotationId: quotation.id, supplierPersonId, status: 'RECEIVED' },
    { transaction }
  );
  for (const line of items) {
    if (!line.purchaseRequestItemId || line.unitPrice == null || Number(line.unitPrice) < 0) {
      throw AppError.badRequest('Cada item precisa de "purchaseRequestItemId" e "unitPrice" >= 0.', 'SUPPLIER_OFFER_VALIDATION');
    }
    const prItem = await PurchaseRequestItem.findByPk(line.purchaseRequestItemId, { transaction });
    if (!prItem) throw AppError.notFound(`Item de requisição "${line.purchaseRequestItemId}" não encontrado.`, 'PURCHASE_REQUEST_ITEM_NOT_FOUND');
    await SupplierOfferItem.create(
      { groupId: quotation.groupId, companyId: quotation.companyId, supplierOfferId: offer.id, purchaseRequestItemId: line.purchaseRequestItemId, unitPrice: line.unitPrice },
      { transaction }
    );
    totalAmount += Number(line.unitPrice) * Number(prItem.quantity);
  }
  offer.totalAmount = totalAmount;
  await offer.save({ transaction });
  return offer;
}

// --- 4. COMPARISON (read-only) ---
async function compareOffers(quotationId, transaction) {
  const quotation = await Quotation.findByPk(quotationId, {
    include: [{ model: SupplierOffer, as: 'offers', include: [{ model: SupplierOfferItem, as: 'items' }] }],
    transaction,
  });
  if (!quotation) throw AppError.notFound('Cotação não encontrada.', 'QUOTATION_NOT_FOUND');
  return quotation.offers.slice().sort((a, b) => Number(a.totalAmount) - Number(b.totalAmount));
}

// --- 5. AWARD -> 6. PO ---
async function awardSupplierOffer(offerId, actorUserId, transaction) {
  // Postgres rejeita FOR UPDATE combinado com include de hasMany (outer join nullable) — lock
  // só na linha da oferta; os itens (imutáveis após submissão) são lidos separadamente.
  const offer = await SupplierOffer.findByPk(offerId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!offer) throw AppError.notFound('Oferta de fornecedor não encontrada.', 'SUPPLIER_OFFER_NOT_FOUND');
  if (offer.status !== 'RECEIVED') {
    throw AppError.badRequest(`Só é possível adjudicar uma oferta RECEIVED (atual: ${offer.status}).`, 'SUPPLIER_OFFER_INVALID_TRANSITION');
  }
  offer.items = await SupplierOfferItem.findAll({ where: { supplierOfferId: offer.id }, transaction });
  const quotation = await Quotation.findByPk(offer.quotationId, { transaction, lock: transaction.LOCK.UPDATE });
  const request = await PurchaseRequest.findByPk(quotation.purchaseRequestId, { transaction, lock: transaction.LOCK.UPDATE });

  const order = await PurchaseOrder.create(
    {
      groupId: offer.groupId,
      companyId: offer.companyId,
      purchaseRequestId: request.id,
      supplierOfferId: offer.id,
      supplierPersonId: offer.supplierPersonId,
      status: 'OPEN',
      committedAmount: offer.totalAmount,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  for (const offerItem of offer.items) {
    const prItem = await PurchaseRequestItem.findByPk(offerItem.purchaseRequestItemId, { transaction });
    await PurchaseOrderItem.create(
      {
        groupId: offer.groupId,
        companyId: offer.companyId,
        purchaseOrderId: order.id,
        inventoryItemId: prItem.inventoryItemId,
        description: prItem.description,
        quantity: prItem.quantity,
        unitPrice: offerItem.unitPrice,
      },
      { transaction }
    );
  }

  offer.status = 'AWARDED';
  await offer.save({ transaction });
  quotation.status = 'CLOSED';
  await quotation.save({ transaction });
  request.status = 'AWARDED';
  request.updatedBy = actorUserId || null;
  await request.save({ transaction });

  await registrarAuditoria({ groupId: order.groupId, companyId: order.companyId, actorUserId, action: 'PURCHASE_ORDER_CREATED', entityType: 'PurchaseOrder', entityId: order.id, reason: `PO gerada a partir da oferta ${offer.id} — custo comprometido ${order.committedAmount}.` }, transaction);

  return getPurchaseOrder(order.id, transaction);
}

async function getPurchaseOrder(id, transaction) {
  const order = await PurchaseOrder.findByPk(id, { include: [{ model: PurchaseOrderItem, as: 'items' }], transaction });
  if (!order) throw AppError.notFound('Pedido de compra não encontrado.', 'PURCHASE_ORDER_NOT_FOUND');
  return order;
}

async function listPurchaseOrders(transaction, { status } = {}) {
  const where = {};
  if (status) where.status = status;
  return PurchaseOrder.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

// --- 7. RECEIPT -> 8. MATCH ---
// EST-TS/Caderno "goods_receipts": over-receipt/invoice sem receipt tratados aqui. O recebimento
// FÍSICO real é delegado a inventory.receipts (nunca duplicamos a lógica de IN/saldo) — este
// serviço só cria o receipt de inventário com os itens do PO e abre discrepâncias.
async function confirmGoodsReceipt(purchaseOrderId, payload, actor, transaction) {
  const { destinationLocationId, invoiceFingerprint, items } = payload;
  if (!destinationLocationId || !Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('"destinationLocationId" e "items" (não vazio) são obrigatórios.', 'GOODS_RECEIPT_VALIDATION');
  }

  if (invoiceFingerprint) {
    const existing = await GoodsReceipt.findOne({ where: { invoiceFingerprint }, transaction });
    if (existing) throw AppError.badRequest(`Já existe um recebimento (${existing.id}) com esta mesma nota fiscal.`, 'GOODS_RECEIPT_DUPLICATE_INVOICE');
  }

  const order = await PurchaseOrder.findByPk(purchaseOrderId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!order) throw AppError.notFound('Pedido de compra não encontrado.', 'PURCHASE_ORDER_NOT_FOUND');
  if (order.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível receber um PO OPEN (atual: ${order.status}).`, 'PURCHASE_ORDER_INVALID_TRANSITION');
  }
  order.items = await PurchaseOrderItem.findAll({ where: { purchaseOrderId: order.id }, transaction });

  const goodsReceipt = await GoodsReceipt.create(
    { groupId: order.groupId, companyId: order.companyId, purchaseOrderId: order.id, destinationLocationId, invoiceFingerprint: invoiceFingerprint || null, status: 'DRAFT', createdBy: actor.userId || null, updatedBy: actor.userId || null },
    { transaction }
  );

  const inventoryReceiptItems = [];
  const discrepancies = [];

  for (const line of items) {
    const poItem = order.items.find((i) => i.id === line.purchaseOrderItemId);
    if (!poItem) throw AppError.notFound(`Item de PO "${line.purchaseOrderItemId}" não encontrado.`, 'PURCHASE_ORDER_ITEM_NOT_FOUND');

    const receivedQty = Number(line.receivedQuantity);
    const remaining = Number(poItem.quantity) - Number(poItem.receivedQuantity);

    const grItem = await GoodsReceiptItem.create(
      { groupId: order.groupId, companyId: order.companyId, goodsReceiptId: goodsReceipt.id, purchaseOrderItemId: poItem.id, receivedQuantity: receivedQty },
      { transaction }
    );

    // EST-TS/Three-way match: recebido > saldo restante do PO = over-receipt (OVER_RECEIPT).
    if (receivedQty > remaining) {
      discrepancies.push(
        await ReceiptDiscrepancy.create(
          { groupId: order.groupId, companyId: order.companyId, goodsReceiptItemId: grItem.id, discrepancyType: 'OVER_RECEIPT', expectedValue: remaining, receivedValue: receivedQty, status: 'OPEN' },
          { transaction }
        )
      );
    }

    poItem.receivedQuantity = Number(poItem.receivedQuantity) + receivedQty;
    await poItem.save({ transaction });

    if (poItem.inventoryItemId && receivedQty > 0) {
      inventoryReceiptItems.push({ inventoryItemId: poItem.inventoryItemId, quantity: receivedQty, unitCost: poItem.unitPrice });
    }
  }

  // Delega a baixa física real a inventory.receipts — nunca duplica a lógica de IN/saldo/custo.
  if (inventoryReceiptItems.length > 0) {
    const inventoryReceipt = await createInventoryReceipt(
      { groupId: order.groupId, companyId: order.companyId, destinationLocationId, invoiceFingerprint: invoiceFingerprint ? `${invoiceFingerprint}:po:${order.id}` : null, items: inventoryReceiptItems },
      actor.userId,
      transaction
    );
    const { reviewReceipt } = require('../inventory/receipts.service');
    await reviewReceipt(inventoryReceipt.id, actor.userId, transaction);
    await confirmInventoryReceipt(inventoryReceipt.id, actor, transaction);
    goodsReceipt.inventoryReceiptId = inventoryReceipt.id;
  }

  const allItemsFullyReceived = order.items.every((i) => Number(i.receivedQuantity) >= Number(i.quantity));
  order.status = allItemsFullyReceived ? 'RECEIVED' : 'OPEN';
  order.updatedBy = actor.userId || null;
  await order.save({ transaction });

  goodsReceipt.status = 'CONFIRMED';
  goodsReceipt.updatedBy = actor.userId || null;
  await goodsReceipt.save({ transaction });

  await registrarAuditoria({ groupId: order.groupId, companyId: order.companyId, actorUserId: actor.userId, action: 'GOODS_RECEIPT_CONFIRMED', entityType: 'GoodsReceipt', entityId: goodsReceipt.id, reason: `Recebimento confirmado — ${discrepancies.length} divergência(s).` }, transaction);

  return { goodsReceipt, discrepancies };
}

async function listDiscrepancies(transaction, { status } = {}) {
  const where = {};
  if (status) where.status = status;
  return ReceiptDiscrepancy.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

// --- Avaliação de fornecedor ---
async function evaluateSupplier(payload, actorUserId, transaction) {
  const { groupId, companyId, supplierPersonId, purchaseOrderId, score, notes } = payload;
  if (!groupId || !companyId || !supplierPersonId || score == null || Number(score) < 1 || Number(score) > 5) {
    throw AppError.badRequest('"groupId", "companyId", "supplierPersonId" e "score" (1 a 5) são obrigatórios.', 'SUPPLIER_EVALUATION_VALIDATION');
  }
  return SupplierEvaluation.create(
    { groupId, companyId, supplierPersonId, purchaseOrderId: purchaseOrderId || null, score, notes: notes || null, createdBy: actorUserId || null },
    { transaction }
  );
}

module.exports = {
  createPurchaseRequest,
  getPurchaseRequest,
  listPurchaseRequests,
  decidePurchaseRequest,
  createQuotation,
  submitSupplierOffer,
  compareOffers,
  awardSupplierOffer,
  getPurchaseOrder,
  listPurchaseOrders,
  confirmGoodsReceipt,
  listDiscrepancies,
  evaluateSupplier,
};
